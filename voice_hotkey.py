#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Global push-to-talk dictation for Windows.

Press the hotkey, speak, press it again. The recording is queued and transcribed
by the same Doubao (Volcengine Seed-ASR) provider that DeepSeek Harness uses.

Delivery rules (in this order):
  * If the foreground window is still the one the recording was aimed at, the
    text is pasted straight to the cursor — and does NOT stay in the clipboard.
  * Otherwise the text is kept in a growing clipboard batch, one per line, ready
    for you to paste with Ctrl+V (or Ctrl+Alt+X) wherever you like.

Keys:
  F9            start / stop recording
  Esc           cancel the recording in progress
  Ctrl+Alt+X    insert the whole batch at the cursor and clear it

Run:  pythonw voice_hotkey.py            (no console window)
      python  voice_hotkey.py --selftest (record 2 s, transcribe, print result)
"""

from __future__ import annotations

import ctypes
import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import tkinter as tk
import uuid
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "config.json")
TRANSCRIBE = os.path.join(HERE, "transcribe.mjs")
LOG_PATH = os.path.join(HERE, "voice_hotkey.log")
HISTORY_PATH = os.path.join(HERE, "voice_hotkey.history.txt")
PID_PATH = os.path.join(HERE, "voice_hotkey.pid")
SAMPLE_RATE = 16000
CHANNELS = 1


def log(message: str) -> None:
    """Append one line to the tool's own log, rotating once it grows past 200 KB."""
    try:
        if os.path.getsize(LOG_PATH) > 200_000:
            os.replace(LOG_PATH, LOG_PATH + ".1")
    except OSError:
        pass
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as handle:
            handle.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}\n")
    except OSError:
        pass


def remember(text: str) -> None:
    """Append one transcript to the on-disk history."""
    try:
        with open(HISTORY_PATH, "a", encoding="utf-8") as handle:
            handle.write(f"--- {time.strftime('%Y-%m-%d %H:%M:%S')}\n{text}\n")
    except OSError:
        pass


DEFAULT_CONFIG = {
    "hotkey": "f9",
    "device": None,
    "maxSeconds": 600,
    "autoPaste": True,
    "overlay": True,
}


def load_config() -> dict:
    config = dict(DEFAULT_CONFIG)
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8-sig") as handle:
            config.update(json.load(handle))
    except Exception:
        pass
    return config


# --------------------------------------------------------------------------- #
# Windows glue
# --------------------------------------------------------------------------- #

VK_CONTROL = 0x11
VK_MENU = 0x12
VK_V = 0x56
KEYEVENTF_KEYUP = 0x0002


def foreground_window() -> int:
    try:
        return int(ctypes.windll.user32.GetForegroundWindow())
    except Exception:
        return 0


def window_title(hwnd: int) -> str:
    try:
        buffer = ctypes.create_unicode_buffer(256)
        ctypes.windll.user32.GetWindowTextW(hwnd, buffer, 256)
        return buffer.value
    except Exception:
        return ""


GWL_EXSTYLE = -20
WS_EX_NOACTIVATE = 0x08000000
WS_EX_TOOLWINDOW = 0x00000080


def make_non_activating(window: tk.Toplevel) -> set[int]:
    """Keep the overlay from ever becoming the foreground window.

    Without WS_EX_NOACTIVATE a shown Toplevel takes focus, and the recorded
    "target window" becomes the overlay itself — every Ctrl+V lands nowhere.
    """
    handles: set[int] = set()
    try:
        window.update_idletasks()
        user32 = ctypes.windll.user32
        inner = int(window.winfo_id())
        outer = int(user32.GetParent(inner)) or inner
        for hwnd in (inner, outer):
            style = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
            user32.SetWindowLongW(hwnd, GWL_EXSTYLE, style | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW)
            handles.add(hwnd)
    except Exception:
        pass
    return handles


def _key_down(vk: int) -> bool:
    try:
        return bool(ctypes.windll.user32.GetAsyncKeyState(vk) & 0x8000)
    except Exception:
        return False


def wait_modifiers_up(timeout: float = 1.5) -> bool:
    """Wait until the user has released Ctrl and Alt before injecting a paste.

    Sending Ctrl+V while the user's fingers still hold Alt (from a Ctrl+Alt+X
    chord) makes the system see Alt+Ctrl+V instead of Ctrl+V — the paste is
    swallowed. Wait the chord out first.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not _key_down(VK_CONTROL) and not _key_down(VK_MENU):
            return True
        time.sleep(0.02)
    return False


def send_ctrl_v() -> None:
    """Paste into whatever window currently has focus."""
    wait_modifiers_up()
    user32 = ctypes.windll.user32
    user32.keybd_event(VK_CONTROL, 0, 0, 0)
    user32.keybd_event(VK_V, 0, 0, 0)
    time.sleep(0.03)
    user32.keybd_event(VK_V, 0, KEYEVENTF_KEYUP, 0)
    user32.keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0)


def set_clipboard(text: str) -> None:
    try:
        import pyperclip

        pyperclip.copy(text)
    except Exception as error:
        log(f"clipboard write failed: {error}")


def get_clipboard() -> str | None:
    try:
        import pyperclip

        return pyperclip.paste()
    except Exception:
        return None


def join_text(parts: list[str]) -> str:
    """Join separate dictations one per line: predictable, easy to edit."""
    return "\n".join(part.strip() for part in parts if part and part.strip())


def find_node() -> str:
    found = shutil.which("node")
    if found:
        return found
    for candidate in (
        r"C:\Program Files\nodejs\node.exe",
        r"C:\Program Files (x86)\nodejs\node.exe",
    ):
        if os.path.isfile(candidate):
            return candidate
    raise RuntimeError("找不到 node.exe，请确认 Node.js 已安装")


# --------------------------------------------------------------------------- #
# Overlay
# --------------------------------------------------------------------------- #


class Overlay:
    """Small always-on-top status pill in the bottom-right corner."""

    BG = "#111318"
    FG = "#f5f7fa"

    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.window = tk.Toplevel(root)
        self.window.overrideredirect(True)
        self.window.attributes("-topmost", True)
        self.window.attributes("-alpha", 0.94)
        self.window.configure(bg=self.BG)

        self.label = tk.Label(
            self.window,
            text="",
            fg=self.FG,
            bg=self.BG,
            font=("Microsoft YaHei UI", 11),
            padx=16,
            pady=9,
        )
        self.label.pack()
        self.hwnds = make_non_activating(self.window)
        self.window.withdraw()
        self._hide_at: float | None = None

    def show(self, text: str, colour: str = "#4ade80", auto_hide: float | None = None) -> None:
        self.label.configure(text=text, fg=colour)
        self.window.update_idletasks()
        width = self.window.winfo_width()
        height = self.window.winfo_height()
        screen_w = self.window.winfo_screenwidth()
        screen_h = self.window.winfo_screenheight()
        self.window.geometry(f"+{screen_w - width - 32}+{screen_h - height - 96}")
        self.window.deiconify()
        self.window.lift()
        self._hide_at = time.time() + auto_hide if auto_hide else None

    def tick(self) -> None:
        if self._hide_at is not None and time.time() >= self._hide_at:
            self._hide_at = None
            self.window.withdraw()

    def hide(self) -> None:
        self._hide_at = None
        self.window.withdraw()


# --------------------------------------------------------------------------- #
# App
# --------------------------------------------------------------------------- #


class DictationApp:
    def __init__(self, root: tk.Tk, config: dict) -> None:
        self.root = root
        self.config = config
        self.overlay = Overlay(root) if config.get("overlay", True) else None
        self.events: "queue.Queue[tuple[str, object]]" = queue.Queue()

        self.stream = None
        self.chunks: list[bytes] = []
        self.started_at = 0.0
        # Most recent foreground window that is not one of our own overlays.
        self.last_external = 0

        self.pending: list[dict] = []
        self.lock = threading.Lock()
        self.worker_active = False

        # Transcripts that could not be pasted (focus moved) wait here as one
        # growing clipboard payload.
        self.backlog: list[str] = []
        self.clip_lock = threading.Lock()
        self.last_clip: str | None = None

        import keyboard

        self.keyboard = keyboard
        hotkey = str(config.get("hotkey") or "f9").lower()
        keyboard.add_hotkey(hotkey, self.toggle)
        keyboard.add_hotkey("esc", self.cancel)
        keyboard.add_hotkey("ctrl+alt+x", self.request_insert)
        log(f"started, hotkey={hotkey}, autoPaste={config.get('autoPaste')}, insert=ctrl+alt+x")

        self.root.after(40, self.poll)

    # -- hotkey handlers (hook thread; only enqueue) ------------------------ #

    def toggle(self) -> None:
        self.events.put(("toggle", None))

    def cancel(self) -> None:
        self.events.put(("cancel", None))

    def request_insert(self) -> None:
        self.events.put(("insert", None))

    # -- main-thread loop --------------------------------------------------- #

    def poll(self) -> None:
        try:
            self._poll_once()
        except Exception as error:  # never let one bad event kill the loop
            log(f"poll error (recovered): {error}")
        try:
            self.root.after(40, self.poll)
        except Exception:
            pass

    def _poll_once(self) -> None:
        try:
            while True:
                kind, payload = self.events.get_nowait()
                if kind == "toggle":
                    self.on_toggle()
                elif kind == "cancel":
                    self.on_cancel()
                elif kind == "transcribed":
                    self.on_transcribed(payload)  # type: ignore[arg-type]
                elif kind == "failed":
                    self.on_failed(str(payload))
                elif kind == "insert":
                    self.on_insert()
        except queue.Empty:
            pass

        if self.stream is not None:
            elapsed = time.time() - self.started_at
            if self.overlay is not None:
                suffix = f"   · 待转写 {len(self.pending)}" if self.pending else ""
                self.overlay.show(f"● 录音中  {int(elapsed // 60)}:{int(elapsed % 60):02d}{suffix}", "#f87171")
            if elapsed >= float(self.config.get("maxSeconds") or 600):
                self.finish_recording()
            current = foreground_window()
            if current and (self.overlay is None or current not in self.overlay.hwnds):
                self.last_external = current

        if self.overlay is not None:
            self.overlay.tick()

    def on_toggle(self) -> None:
        if self.stream is not None:
            self.finish_recording()
        else:
            self.start_recording()

    def on_cancel(self) -> None:
        if self.stream is None:
            return
        self.close_stream()
        self.chunks = []
        if self.overlay is not None:
            self.overlay.show("已取消", "#94a3b8", auto_hide=1.0)

    def start_recording(self) -> None:
        import sounddevice as sd

        self.chunks = []

        def callback(indata, _frames, _time_info, _status) -> None:
            self.chunks.append(bytes(indata))

        device = self.config.get("device")
        try:
            self.stream = sd.RawInputStream(
                samplerate=SAMPLE_RATE,
                channels=CHANNELS,
                dtype="int16",
                device=device,
                callback=callback,
            )
            self.stream.start()
        except Exception as error:
            self.stream = None
            if self.overlay is not None:
                self.overlay.show(f"打不开麦克风：{error}", "#f87171", auto_hide=4.0)
            return

        self.started_at = time.time()
        log("recording started")

    def close_stream(self) -> None:
        stream, self.stream = self.stream, None
        if stream is None:
            return
        try:
            stream.stop()
            stream.close()
        except Exception:
            pass

    def finish_recording(self) -> None:
        if self.stream is None:
            return
        self.close_stream()
        pcm = b"".join(self.chunks)
        self.chunks = []
        seconds = len(pcm) / (SAMPLE_RATE * 2)
        if len(pcm) < SAMPLE_RATE // 2:
            if self.overlay is not None:
                self.overlay.show("太短了，没录到内容", "#fbbf24", auto_hide=1.5)
            return

        path = os.path.join(tempfile.gettempdir(), f"dsh-dictation-{uuid.uuid4().hex}.wav")
        with wave.open(path, "wb") as handle:
            handle.setnchannels(CHANNELS)
            handle.setsampwidth(2)
            handle.setframerate(SAMPLE_RATE)
            handle.writeframes(pcm)

        with self.lock:
            origin = self.last_external or foreground_window()
            self.pending.append({"path": path, "seconds": seconds, "window": origin})
            depth = len(self.pending)
            should_start = not self.worker_active
            if should_start:
                self.worker_active = True

        log(f"queued {seconds:.1f}s, depth={depth}, target={origin} ({window_title(origin)})")
        if should_start:
            threading.Thread(target=self.worker_loop, daemon=True).start()
        if self.overlay is not None:
            self.overlay.show(f"转写中…  {seconds:.0f}s 音频" + (f"  · 还有 {depth - 1} 段" if depth > 1 else ""), "#60a5fa")

    def worker_loop(self) -> None:
        while True:
            with self.lock:
                if not self.pending:
                    self.worker_active = False
                    return
                job = self.pending.pop(0)
            try:
                with self.lock:
                    remaining = len(self.pending)
                log(f"worker start, remaining={remaining}")
                text = self.run_transcribe(job["path"])
                log("worker done")
                self.events.put(("transcribed", (text, job["window"])))
            except Exception as error:
                self.events.put(("failed", str(error)))
            finally:
                try:
                    os.remove(job["path"])
                except OSError:
                    pass

    def run_transcribe(self, path: str) -> str:
        completed = subprocess.run(
            [find_node(), TRANSCRIBE, path],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=600,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if completed.returncode != 0:
            raise RuntimeError((completed.stderr or "识别失败").strip())
        return completed.stdout.strip()

    # -- delivery ----------------------------------------------------------- #

    def on_transcribed(self, payload) -> None:
        text, origin = payload
        if not text:
            log("transcribed: empty (no speech)")
            if self.overlay is not None:
                self.overlay.show("没听清，再试一次", "#fbbf24", auto_hide=1.8)
            return

        remember(text)

        same_window = origin == 0 or foreground_window() == origin
        log(f"deliver: origin={origin} ({window_title(origin)}) now={foreground_window()} ({window_title(foreground_window())}) -> {'paste' if same_window else 'clipboard'}")

        if self.config.get("autoPaste", True) and same_window:
            # Reached the cursor: clear the batch; the clipboard keeps just this
            # text so a silent miss can still be recovered with a plain Ctrl+V.
            with self.clip_lock:
                self.backlog.clear()
                set_clipboard(text)
                self.last_clip = text
            threading.Thread(target=self.deliver_paste, args=(text,), daemon=True).start()
            message, colour = "✓ 已插入", "#4ade80"
        else:
            depth = self.append_backlog(text)
            message, colour = f"✓ 已在剪贴板（{depth} 段）按 Ctrl+V", "#38bdf8"

        if self.overlay is not None:
            self.overlay.show(message, colour, auto_hide=2.6)

    def append_backlog(self, text: str) -> int:
        """Add one undelivered transcript and publish the whole batch."""
        with self.clip_lock:
            current = get_clipboard()
            if self.last_clip is not None and current != self.last_clip:
                self.backlog.clear()  # you copied something else meanwhile
            self.backlog.append(text)
            combined = join_text(self.backlog)
            set_clipboard(combined)
            self.last_clip = combined
            return len(self.backlog)

    def deliver_paste(self, text: str) -> None:
        with self.clip_lock:
            set_clipboard(text)
            self.last_clip = text
        send_ctrl_v()
        log(f"pasted {len(text)} chars")

    def on_insert(self) -> None:
        """Manual insert: paste the whole batch at the cursor, then clear it."""
        with self.clip_lock:
            if not self.backlog:
                text = ""
            else:
                text = join_text(self.backlog)
                set_clipboard(text)
                self.last_clip = text
                self.backlog.clear()
        if not text:
            if self.overlay is not None:
                self.overlay.show("批次是空的", "#94a3b8", auto_hide=1.6)
            return
        send_ctrl_v()
        log(f"inserted {len(text)} chars, batch cleared")
        if self.overlay is not None:
            self.overlay.show("✓ 已插入（批次已清空）", "#4ade80", auto_hide=1.8)

    def on_failed(self, message: str) -> None:
        log(f"failed: {message}")
        if self.overlay is not None:
            self.overlay.show(f"✗ {message}", "#f87171", auto_hide=5.0)


# --------------------------------------------------------------------------- #
# Single instance
# --------------------------------------------------------------------------- #


def is_pid_alive(pid: int) -> bool:
    try:
        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        ctypes.windll.kernel32.CloseHandle(handle)
        return True
    except Exception:
        return False


def acquire_single_instance() -> bool:
    try:
        if os.path.exists(PID_PATH):
            with open(PID_PATH) as handle:
                old_pid = int(handle.read().strip() or "0")
            if old_pid and old_pid != os.getpid() and is_pid_alive(old_pid):
                return False
        with open(PID_PATH, "w") as handle:
            handle.write(str(os.getpid()))
        return True
    except Exception:
        return True


# --------------------------------------------------------------------------- #
# Entry points
# --------------------------------------------------------------------------- #


def selftest(config: dict) -> int:
    import sounddevice as sd

    print("录音 2 秒…", flush=True)
    frames = []
    with sd.RawInputStream(samplerate=SAMPLE_RATE, channels=CHANNELS, dtype="int16", device=config.get("device")) as stream:
        deadline = time.time() + 2.0
        while time.time() < deadline:
            data, _overflow = stream.read(1024)
            frames.append(bytes(data))
    pcm = b"".join(frames)
    print(f"采集 {len(pcm) / (SAMPLE_RATE * 2):.2f}s，开始转写…", flush=True)

    path = os.path.join(tempfile.gettempdir(), "dsh-dictation-selftest.wav")
    with wave.open(path, "wb") as handle:
        handle.setnchannels(CHANNELS)
        handle.setsampwidth(2)
        handle.setframerate(SAMPLE_RATE)
        handle.writeframes(pcm)

    completed = subprocess.run(
        [find_node(), TRANSCRIBE, path],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=600,
    )
    print("returncode:", completed.returncode)
    print("stdout:", completed.stdout.strip() or "(空)")
    print("stderr:", completed.stderr.strip() or "(无)")
    return completed.returncode


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    def excepthook(exc_type, exc, tb):
        log(f"UNCAUGHT {exc_type.__name__}: {exc}")

    sys.excepthook = excepthook
    threading.excepthook = lambda args: log(f"THREAD UNCAUGHT: {args.exc_type.__name__}: {args.exc_value}")

    config = load_config()
    if "--selftest" in sys.argv:
        return selftest(config)

    if not acquire_single_instance():
        log("already running, exiting this launch")
        return 0

    root = tk.Tk()
    root.withdraw()
    DictationApp(root, config)
    root.mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
