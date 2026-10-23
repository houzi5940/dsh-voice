// tts.mode policy test: 'first' speaks only the opening sentence per turn,
// 'off' mutes synthesis, 'all' keeps every sentence. The llm/stream tap must
// stay lossless in every mode.
import { apply, Config } from '../lib/index.js'

function makeCtx(capture) {
  return {
    on(name, fn) {
      capture.listeners.set(name, fn)
    },
    effect(fn) {
      const r = fn()
      return r ?? (() => {})
    },
    webServer: {
      register(route) {
        capture.routes.push(route)
        return () => {}
      },
    },
  }
}

function baseConfig(overrides) {
  return {
    basePath: '/dsh-voice-api',
    voice: 'zh-CN-XiaoxiaoNeural',
    enabled: true,
    cacheDir: '/tmp/dsh-voice-test-cache',
    asr: {
      model: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
      modelHost: 'https://huggingface.co',
      language: 'auto',
      useItn: true,
      autoSend: false,
      mode: 'toggle',
      hotkey: 'Control',
    },
    tts: { mode: 'all' },
    ...overrides,
  }
}

async function collectFrames(ttsMode) {
  const capture = { listeners: new Map(), routes: [] }
  const ctx = makeCtx(capture)
  apply(ctx, baseConfig(ttsMode ? { tts: { mode: ttsMode } } : undefined))
  const llmStream = capture.listeners.get('llm/stream')

  const frames = []
  const res = {
    writeHead() {},
    write(s) {
      if (s.startsWith('event: audio')) {
        const line = s.split('\n').find((l) => l.startsWith('data: '))
        if (line) frames.push(JSON.parse(line.slice(6)))
      }
    },
    on() {},
    end() {},
  }
  const sse = capture.routes.find((r) => r.path === '/dsh-voice-api/stream')
  sse.handler({ on() {} }, res)

  async function* mockStream() {
    yield { type: 'text-delta', index: 0, text: '第一句说完。' }
    yield { type: 'text-delta', index: 0, text: '第二句。第三句。' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const seen = []
  for await (const chunk of llmStream({ sessionId: 's1' }, mockStream)) seen.push(chunk)

  const deadline = Date.now() + 20000
  const target = ttsMode === 'off' ? 0 : ttsMode === 'first' ? 1 : 3
  while (frames.length < target && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200))
  }
  return { frames, seen }
}

// --- 'all' (default): every sentence is spoken, tap is lossless ---
{
  const { frames, seen } = await collectFrames('all')
  if (seen.length !== 3) throw new Error(`'all' tap corrupted: ${seen.length} chunks`)
  if (frames.length !== 3) throw new Error(`'all' expected 3 frames, got ${frames.length}`)
  console.log("  ok  mode 'all':", frames.length, 'frames,', seen.length, 'chunks passthrough')
}

// --- 'first': only the opening sentence is spoken; transcript untouched ---
{
  const { frames, seen } = await collectFrames('first')
  if (seen.length !== 3) throw new Error(`'first' tap corrupted: ${seen.length} chunks`)
  if (frames.length !== 1) throw new Error(`'first' expected 1 frame, got ${frames.length}`)
  if (frames[0].text !== '第一句说完。') throw new Error('first frame text wrong: ' + frames[0].text)
  console.log("  ok  mode 'first': spoke only", JSON.stringify(frames[0].text))
}

// --- 'off': nothing is synthesized at all ---
{
  const { frames, seen } = await collectFrames('off')
  if (seen.length !== 3) throw new Error(`'off' tap corrupted: ${seen.length} chunks`)
  if (frames.length !== 0) throw new Error(`'off' expected 0 frames, got ${frames.length}`)
  console.log("  ok  mode 'off': muted, 0 frames")
}

// --- config schema: tts.mode and asr.silenceMs defaults/ranges ---
// Volatile fields carry defaults in schema meta and only materialize when
// the Loader composes a real config source; assertions read meta instead.
{
  const hotkeyMeta = Config.dict.asr.dict.hotkey.meta
  if (hotkeyMeta.default !== 'Control' || hotkeyMeta.volatile !== true) {
    throw new Error('asr.hotkey volatile default wrong: ' + JSON.stringify(hotkeyMeta))
  }
  const silenceMeta = Config.dict.asr.dict.silenceMs.meta
  if (silenceMeta.default !== 2000 || silenceMeta.volatile !== true) {
    throw new Error('asr.silenceMs volatile default wrong: ' + JSON.stringify(silenceMeta))
  }
  const modeMeta = Config.dict.tts.dict.mode.meta
  if (modeMeta.default !== 'all' || modeMeta.volatile !== true) {
    throw new Error('tts.mode volatile default wrong: ' + JSON.stringify(modeMeta))
  }
  const voiceMeta = Config.dict.voice.meta
  if (voiceMeta.default !== 'zh-CN-XiaoxiaoNeural' || voiceMeta.volatile !== true) {
    throw new Error('voice volatile default wrong: ' + JSON.stringify(voiceMeta))
  }
  const enabledMeta = Config.dict.enabled.meta
  if (enabledMeta.default !== true || enabledMeta.volatile !== true) {
    throw new Error('enabled volatile default wrong: ' + JSON.stringify(enabledMeta))
  }
  // Non-volatile fields still resolve eagerly.
  const eager = new Config({})
  if (eager.basePath !== '/dsh-voice-api') throw new Error('basePath default wrong: ' + eager.basePath)
  // Range floor still enforced at construction time (volatile or not).
  let threw = false
  try {
    new Config({ asr: { silenceMs: 50 } })
  } catch {
    threw = true
  }
  if (!threw) throw new Error('silenceMs=50 should have failed the 200ms floor')
  // Volatile cells are resolved by the Loader at composition time, not by
  // new Config(...); the live /config probe in host.integration covers the
  // end-to-end resolution (autoSend/silenceMs/hotkey all materialize).
  console.log('  ok  config: volatile defaults in schema meta, floor enforced')
}

console.log('\nALL TTS-MODE TESTS PASSED')
