豆包语音输入（热键版）
======================

全局按住说话 → 豆包转文字 → 剪贴板 → 手动粘贴。任何软件都能用，
切窗口、切对话都不受影响。

用法
----
F9          开始录音，再按一次结束。文字进剪贴板（多段自动累积，每段一行）。
Ctrl+V      把剪贴板里的内容贴到当前光标。
Ctrl+Alt+X  贴到当前光标，并清空剪贴板批次。
Esc         取消正在进行的录音。

安装步骤（新电脑）
------------------
1. 装好 Node.js（https://nodejs.org ，LTS 版）和 Python（https://www.python.org ，
   安装时勾选 "Add python.exe to PATH"）。
2. 双击「安装依赖.bat」，它会自动 pip 安装 sounddevice / keyboard / pyperclip。
3. 用记事本打开 credentials.json，填入你的火山引擎 App ID 和 Access Token：
       appKey     -> App ID（火山语音控制台里的 APPID）
       accessKey  -> Access Token
   endpoint 和 resourceId 已经填好，一般不用改。
4. 双击「启动语音输入.vbs」开始用。
5. （可选）双击「安装自启.bat」，开机自动后台运行。

获取凭据
--------
火山引擎控制台：https://console.volcengine.com/speech/app
创建应用时勾选「流式语音识别大模型」（Seed-ASR 2.0），应用详情里能看到
AppID 和 Access Token。

改按键 / 其他设置
-----------------
编辑 config.json：
    hotkey        录音快捷键（默认 f9，可改成 f8、ctrl+alt+space 等）
    device        麦克风名（null = 系统默认）
    maxSeconds    单次录音上限（默认 600 秒）
    autoPaste     true = 转写完自动粘贴（不推荐，见下）；false = 手动（默认）
    overlay       是否显示右下角悬浮状态窗

为什么默认不自动粘贴
--------------------
自动粘贴需要判断"光标当前在不在输入框里"，而很多程序（尤其是 Electron 做的，
比如 DeepSeek Harness）对外只暴露同一个窗口，程序分不清光标在输入框还是正文，
容易把字贴丢。所以默认手动，由你决定贴到哪。

日志和备份
----------
- voice_hotkey.log      运行日志，出问题看这里
- voice_hotkey.history.txt   每段转写文字都存一份，丢了能找回来

停止运行
--------
双击「停止语音输入.bat」。
