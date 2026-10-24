# doubao-voice-input

Global push-to-talk dictation for Windows, powered by Volcengine's **Doubao (豆包)
Seed-ASR 2.0** streaming speech recognition.

Press a hotkey, talk, press it again — the audio is transcribed and placed on your
clipboard, ready to paste into any app. Nothing is auto-pasted where you don't want
it, and long recordings are chunked, transcribed concurrently, and joined.

中文：全局热键录音 → 豆包转文字 → 剪贴板 → 手动粘贴。切窗口、切软件都不受影响。

## Why

- Dictate long paragraphs without being stuck in one input box.
- Same recognition engine as the Doubao app/web UI (Seed-ASR 2.0), via its
  official WebSocket streaming API.
- No cloud storage of audio: each chunk is sent only for the duration of one
  recognition request.

## Features

- **F9** toggles recording (configurable), **Ctrl+Alt+X** pastes and clears the batch.
- Recordings **queue** while transcription runs — keep talking, never blocked.
- Long audio is **split at quiet points** and transcribed with bounded concurrency
  (the API caps concurrent sessions and enforces an idle timeout).
- An always-on-top status pill shows state, and never steals focus.
- Every transcript is appended to a local history file so nothing is lost.
- Offline-friendly setup: only Node.js + Python (with a few packages) are required.

## Requirements

- Windows 10/11
- [Node.js](https://nodejs.org) (LTS) — runs the transcription client
- [Python](https://www.python.org) 3.9+ — runs the recorder/hotkey loop
- A Volcengine account with the **流式语音识别大模型 (Seed-ASR 2.0)** service enabled

## Setup

1. Install Node.js and Python (tick "Add python.exe to PATH").
2. Install Python packages:

   ```bat
   安装依赖.bat
   ```

   (or `python -m pip install sounddevice keyboard pyperclip`)

3. Copy `credentials.example.json` to `credentials.json` and fill in your
   App ID and Access Token from the
   [Volcengine speech console](https://console.volcengine.com/speech/app).
   `endpoint` and `resourceId` are already set for Seed-ASR 2.0.

4. Launch:

   ```bat
   启动语音输入.vbs
   ```

   Optional: `安装自启.bat` installs a startup shortcut.

## Usage

| Key | Action |
| --- | --- |
| `F9` | start / stop recording |
| `Ctrl+Alt+X` | paste the clipboard batch at the cursor and clear it |
| `Esc` | cancel the recording in progress |

Text always lands on the clipboard first; paste it wherever you like. Multiple
recordings accumulate one per line until you paste.

## Configuration (`config.json`)

```json
{
  "hotkey": "f9",
  "device": null,
  "maxSeconds": 600,
  "autoPaste": false,
  "overlay": true
}
```

- `hotkey` — recording hotkey (`f8`, `ctrl+alt+space`, …)
- `device` — microphone name (`null` = system default)
- `maxSeconds` — per-recording cap
- `autoPaste` — `true` pastes automatically when the foreground window is
  unchanged (off by default; see below)
- `overlay` — show the corner status pill

### Why `autoPaste` is off by default

Deciding "is the cursor in a text field right now?" from window handles alone is
unreliable — Electron apps in particular expose one window whether focus is in
the composer or the transcript. So the default keeps text on the clipboard and
lets you paste explicitly.

## How transcription works

`transcribe.mjs` calls `provider/index.js`, a dependency-free Node client for the
Volcengine Seed-ASR 2.0 streaming WebSocket (`/api/v3/sauc/bigmodel_async`,
resource `volc.seedasr.sauc.duration`). It implements the binary framing (gzip +
PCM16), sets an utterance `end_window_size` so speech is not cut at every packet,
and splits audio into ≤12 s segments transcribed 3-at-a-time — the API rejects
more concurrent sessions and kills any session that idles for ~10 s.

## Logs & recovery

- `voice_hotkey.log` — runtime log
- `voice_hotkey.history.txt` — every transcript, timestamped

## License

[MIT](LICENSE)
