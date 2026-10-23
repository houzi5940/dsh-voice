# dsh-voice

[English](./README.md) | 简体中文

DeepSeek Harness（dsh）的**全双工语音插件**：说话 → 语音识别 → 模型流式回答 → 语音朗读，并且支持**开口即打断**（barge-in）。

```
说话 ──▶ SenseVoice 识别 ──▶ composer 草稿 / 提交 ──▶ 模型流式输出
                                                        │
        ◀── 浏览器 SSE 播放（MP3 + 字幕）◀── 分句 + Edge TTS 合成
```

## 特性

- **三种说话方式**：点按连续听写、长按发送键说话、长按快捷键说话。
- **实时字幕**：长按期间浮层里持续显示"已说的内容"预览，松手后显示识别中状态，直到最终文本落地。
- **真正的语音打断**：检测到用户开口的瞬间，本地播放停止、host 合成队列清空（连正在合成的那一句一起丢弃）、正在运行的轮次被取消；被打断的轮次不会补读半句话。
- **回声消除**：使用页面自身的 TTS 播放作为参考信号，运行 NLMS 自适应回声消除器，避免外放时把助手自己的声音误判成用户开口。浏览器原生 `echoCancellation` 仅在没有参考信号时兜底。
- **中文原生 ASR**：host 端使用 [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)（Apache-2.0）运行 **SenseVoice**，原生输出简体中文，自带标点、ITN（数字/符号规范化）与 50+ 语种自动识别。
- **不阻塞模型流**：对 `llm/stream` 是无损 tap，每个 chunk 原样透传，分句与合成完全旁路进行。
- **模型缓存与断点续传**：模型文件通过 host 端缓存代理下载并落盘，支持 Range 与 `.part` 续传，也支持 HuggingFace 镜像。

## 环境要求

- Node.js ≥ 22.19 或 ≥ 24（依赖 `node:zlib` 的 zstd API）
- dsh `0.1.0-rc.6` 或 `0.2.x`（插件的 `@deepseek-ai/dsh-web` peer 范围已覆盖两者）
- 一个可用的 dsh `web` profile
- 浏览器麦克风权限

## 安装

```sh
dsh plugin --profile web add <repo-url-or-path>
dsh --profile web
```

首次使用时，host 会按需下载 SenseVoice 模型（数百 MB）到本地缓存；也可以提前预热：

```sh
npm run prefetch          # 默认访问 http://127.0.0.1:3080，需 dsh 正在运行
```

## 使用

| 操作 | 行为 |
| --- | --- |
| 点按麦克风 | 连续听写，VAD（RMS 能量）在尾部静音处自动断句 |
| **长按发送键**（或麦克风） | 按住即录音，松开发送，上滑取消 |
| **长按 `Ctrl`**（可配置 `asr.hotkey`） | 不离开键盘直接说话，松开 `Ctrl` 发送，`Esc` 取消 |

长按期间输入框上方会出现波形浮层：

- 波形来自麦克风实时电平（每 ~64ms 一帧）。
- 实时字幕是**预览**，不是最终结果；它不会写入草稿，松手后迟到的预览会被直接丢弃。
- 松手后浮层进入"识别中…"，直到最终识别结果返回才关闭；空结果或失败也会自动收尾，不会一直转圈。
- 上滑超过 80px 进入取消态，松手即丢弃本次录音。

键盘方式有额外的安全设计：长按阈值 600ms（指针是 260ms），并且按住期间按下任何其他键都会作废本次录音，保证慢速 `Ctrl+C` 不会被当成语音；切换窗口（`blur`）也会取消，避免麦克风一直开着。

## 工作原理

```
输入:  麦克风 ──RMS 端点检测──▶ POST /asr（原始 f32 PCM）
                                    │ 文本（SenseVoice，host 端）
                                    ▼
        composer 草稿 ──提交──▶ 模型流 ──llm/stream tap──▶ SentenceSegmenter
                                                              │
        浏览器 ◀── SSE /dsh-voice-api/stream ── TtsQueue（msedge-tts）◀──┘
                  （base64 MP3 帧 + 字幕文本）

打断:  语音前沿 ──▶ engine.skip() + POST /cancel（epoch +1）
                 + session.cancel()（仅当该会话有运行中的轮次）
```

几个关键设计：

- **host / client 分工**：识别在本机 host 完成，浏览器只负责采集、端点检测和 POST 原始 little-endian f32 PCM（16 kHz 单声道）。浏览器端不加载任何模型。
- **分句**：`SentenceSegmenter` 剥离 Markdown 后按中英文终止标点切句，遇到没有标点的长文本有安全阀；每个 chunk 仍然原样传给下游。
- **合成队列**：`TtsQueue` 按会话串行合成，`cancel()` 通过 epoch 机制同时丢弃排队中和正在合成的内容。
- **增量预览**：每次预览只上传"上次之后新增的音频"（用 `x-dsh-session` 关联），host 对每个会话只解码固定长度的滑动窗口（8s），所以长按再久，预览开销也不增长。超过 12s 停止预览。
- **长按绕过 VAD**：按住本身就是明确意图，所以按下到松开之间的所有音频都会保留；只有短于 250ms 的采集会被当作误触丢弃（时长在补尾垫之前测量）。

隐私边界：语音识别全部在本机 host 完成，音频不会上传到第三方；朗读使用微软 Edge TTS 在线合成（文本会发送到微软服务）。

## 配置

在 dsh 的 bundle patch 中配置：

```yaml
- id: voice
  name: '@haoku123/dsh-voice'
  config:
    basePath: /dsh-voice-api               # HTTP 路由前缀（/dsh-voice-api/config 始终可作为引导路径）
    enabled: true                          # 关闭后不再挂接 llm/stream
    voice: zh-CN-XiaoxiaoNeural            # Edge TTS 音色
    cacheDir: ~/.cache/dsh-voice/models    # 模型磁盘缓存目录
    asr:
      model: csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17
      modelHost: https://huggingface.co    # 国内可改为 https://hf-mirror.com
      language: auto                       # auto | zh | en | ja | ko | yue
      useItn: true                         # 数字/符号规范化
      autoSend: false                      # 点按模式下识别完是否自动提交
      mode: toggle                         # toggle | hold
      hotkey: Control                      # 键盘长按说话键；'' 表示禁用
```

`hotkey` 取 `KeyboardEvent.key` 的值，例如 `Control`、`Alt`、`Meta`、`Shift`、`Space` 或单个字母。

## HTTP API

| 路由 | 用途 |
| --- | --- |
| `GET /dsh-voice-api/stream` | SSE；`event: audio`，帧格式 `{sessionId, seq, text, audio(base64 MP3)}` |
| `POST /dsh-voice-api/asr` | 请求体为原始 little-endian f32 PCM；返回 `{text}`。带 `x-dsh-session` 时为增量预览 |
| `POST /dsh-voice-api/cancel` | `{sessionId}`，清空该会话排队中与合成中的语音（epoch +1） |
| `GET /dsh-voice-api/config` | 返回前端所需的运行时配置 `{asr, basePath}`；该路径固定，自定义 `basePath` 时客户端仍能靠它发现真实前缀 |
| `GET /dsh-voice-api/hf/*` | HuggingFace 模型缓存代理（落盘到 `cacheDir`，支持 Range / 续传） |
| `GET /dsh-voice-api/*` | 连通性探测：`{ok, name, enabled}` |

## 模型缓存

模型下载统一走 `/dsh-voice-api/hf` 缓存代理：

- 首次请求时从 `asr.modelHost` 拉取，同时镜像到 `cacheDir`（按 HF 仓库路径布局）。
- 支持 HTTP Range；中断后从 `.part` 文件续传。
- 之后的每次启动都直接读本地磁盘，不再联网。
- 国内网络把 `modelHost` 改成 `https://hf-mirror.com` 即可。

## 开发

```sh
npm install          # sherpa-onnx 是运行时依赖，必须安装
npm run build        # esbuild：lib/index.js（host）+ lib/client.js（浏览器）
npm test             # host 测试 + client 组件测试
npm run test:host    # segmenter / bargein / bargein-semantics / integration
npm run test:client  # vitest + jsdom
node verify-client.mjs   # 校验 client bundle 的注册、exports、slots
```

改完源码后记得重新 `npm run build`：host 测试直接 import `lib/*.js`。

## 常见问题

**麦克风没反应？**
界面会区分"权限被拒绝 / 找不到设备 / 被其他程序占用"。权限问题请在浏览器地址栏的站点权限里放行麦克风。

**识别很慢？**
首次使用需要下载并加载模型，之后会明显变快。建议先 `npm run prefetch`，并确认 `cacheDir` 可写。

**外放时助手会打断自己？**
插件已经用 TTS 播放作为参考信号做 NLMS 回声消除。若仍有误触发，可降低系统音量，或关闭 `noiseSuppression` / `autoGainControl` 不友好的音频驱动；耳机效果最好。

**`Ctrl` 热键与编辑器快捷键冲突？**
把 `asr.hotkey` 改成 `Alt`、`Space` 等其他键，或设为 `''` 关闭键盘模式，只保留发送键长按。

**模型下载失败？**
切换 `asr.modelHost` 为镜像源后重启 dsh；已下载的部分会从 `.part` 继续。

## 许可

[MIT](./LICENSE)

第三方组件：

- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)（Apache-2.0）与 SenseVoice 模型
- [msedge-tts](https://www.npmjs.com/package/msedge-tts)（Edge TTS 在线合成）
