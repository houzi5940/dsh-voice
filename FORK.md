# Fork notes

This repository is a customized fork of
[`haoku123/dsh-voice`](https://github.com/haoku123/dsh-voice) (MIT), based on
upstream commit `b153438` ("fix: support dsh 0.2").

The package name is kept as `@haoku123/dsh-voice` so the fork is a drop-in
replacement for the upstream plugin in an existing profile. Install this fork
by repo URL:

```sh
dsh plugin --profile <profile> add github:houzi5940/dsh-voice
```

## Changes on top of upstream

### Speech reading

- `tts.mode`: `first` (first sentence), `paragraph` (first paragraph, streamed),
  `all`, `off`. The new `ParagraphGate` (`src/segmenter.ts`) detects the first
  blank line while the reply streams, so speech starts before the turn ends;
  the session transcript is untouched (the `llm/stream` tap stays lossless).
- Speaker button on every finalized assistant message
  (`conversation.chat.assistant-actions`): `POST /dsh-voice-api/replay` reads
  the message text from the session store, applies the same `tts.mode` policy,
  synthesizes MP3 and returns it. Playback shares the TTS element, so barge-in
  still stops it.

### Recognition

- `asr.energyThreshold` (RMS speech trigger, live-tunable), plus the existing
  `asr.silenceMs`; both are re-read from `/config` before each recording, so
  edits apply without a page refresh.
- SenseVoice model auto-download on first use (239 MB, resumable `.part`),
  `/status` for progress, `POST /model` to start it manually, and a 503 +
  retry loop so the user's first utterance is not lost while it downloads.
  Upstream never downloaded the model; sherpa-onnx silently decodes missing
  weights to an empty string, which looked like "mic works but nothing sends".
- Fixed a crash when the TTS echo reference lives in a different
  `AudioContext` (Chromium `InvalidStateError`); the recorder falls back to
  browser AEC instead of failing the capture.
- Settings UI: a "语音对话" page in the Settings panel and a configuration
  section on the plugin page, both driven by the Host Settings form service
  (`plugins.bundle.config` / `settings.section`).

### Housekeeping

- Idle TTS websocket closed when the queue drains (it pinned the Node event
  loop, hanging plain-node tests).
- Added tests: paragraph gate, tts modes, replay route, threshold behaviour,
  settings form, cross-context AEC.

## Licensing

Upstream is MIT; see `LICENSE`. All upstream copyright notices are retained.
