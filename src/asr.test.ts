/**
 * Press-to-talk capture semantics for the ASR engine.
 *
 * The regression this guards: in tap mode audio only enters a segment once
 * RMS crosses ENERGY_THRESHOLD, so a quiet utterance never sets speechActive
 * and the buffer is dropped on stop. Under press-to-talk that looks exactly
 * like a dead button — the hold itself is the intent, so everything between
 * press and release must be transcribed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAsrEngine, type AsrConfig } from './asr.ts'

const BUFFER = 1024

/** Minimal browser surface the engine touches, with a scriptable mic. */
function installFakeAudio(): { tick(amplitude: number): void; ctx: unknown; constraints(): unknown } {
  let onaudioprocess: ((e: unknown) => void) | null = null
  const processor = {
    set onaudioprocess(fn: (e: unknown) => void) { onaudioprocess = fn },
    get onaudioprocess() { return onaudioprocess as (e: unknown) => void },
    connect() {},
    disconnect() {},
  }
  const ctx = {
    createMediaStreamSource: () => ({ connect() {} }),
    createScriptProcessor: () => processor,
    destination: {},
    close: async () => {},
  }
  vi.stubGlobal('AudioContext', function AudioContextStub() { return ctx })
  let constraints: unknown = null
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: async (request: unknown) => {
        constraints = request
        return { getTracks: () => [] }
      },
    },
  })
  vi.stubGlobal('location', { origin: 'http://127.0.0.1:3080' })
  return {
    ctx,
    constraints: () => constraints,
    tick(amplitude: number) {
      const data = new Float32Array(BUFFER)
      for (let i = 0; i < BUFFER; i++) data[i] = amplitude * (i % 2 === 0 ? 1 : -1)
      onaudioprocess?.({ inputBuffer: { getChannelData: () => data } })
    },
  }
}

/** Capture the PCM the engine POSTs to the host, and answer with a transcript. */
function installFetchCapture(
  reply: string | ((call: number) => string) = '识别结果',
): { bytes: number }[] {
  const calls: { bytes: number }[] = []
  vi.stubGlobal('fetch', async (_url: string, init: { body: ArrayBuffer }) => {
    calls.push({ bytes: init.body.byteLength })
    const text = typeof reply === 'function' ? reply(calls.length) : reply
    return { ok: true, status: 200, json: async () => ({ text }) }
  })
  return calls
}

const cfg: AsrConfig = { mode: 'toggle', autoSend: false }
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

afterEach(() => vi.unstubAllGlobals())

describe('press-to-talk capture', () => {
  let audio: { tick(a: number): void }
  beforeEach(() => { audio = installFakeAudio() })

  it('keeps quiet speech that the VAD would have discarded', async () => {
    const posts = installFetchCapture('轻声说的话')
    const engine = createAsrEngine(cfg, '/dsh-voice-api')
    const seen: string[] = []
    engine.onSegment((t) => seen.push(t))

    await engine.start({ hold: true })
    // 0.008 RMS is real speech on a quiet mic, but below ENERGY_THRESHOLD.
    for (let i = 0; i < 20; i++) audio.tick(0.008) // ~1.28s
    await engine.stop()
    await settle()

    expect(posts).toHaveLength(1)
    expect(seen).toEqual(['轻声说的话'])
  })

  it('leaves tap-mode VAD gating untouched', async () => {
    const posts = installFetchCapture()
    const engine = createAsrEngine(cfg, '/dsh-voice-api')

    await engine.start()
    for (let i = 0; i < 20; i++) audio.tick(0.008) // below threshold
    await engine.stop()
    await settle()

    expect(posts).toHaveLength(0)
  })

  it('drops a hold shorter than the intelligibility floor', async () => {
    const posts = installFetchCapture()
    const engine = createAsrEngine(cfg, '/dsh-voice-api')

    await engine.start({ hold: true })
    audio.tick(0.3) // a single 64ms buffer
    await engine.stop()
    await settle()

    expect(posts).toHaveLength(0)
  })

  it('discards a loud capture when cancelled', async () => {
    const posts = installFetchCapture()
    const engine = createAsrEngine(cfg, '/dsh-voice-api')

    await engine.start({ hold: true })
    for (let i = 0; i < 30; i++) audio.tick(0.25)
    await engine.cancel()
    await settle()

    expect(posts).toHaveLength(0)
    expect(engine.state).toBe('idle')
  })

  it('is only finalized on release, never by trailing silence', async () => {
    const posts = installFetchCapture()
    const engine = createAsrEngine(cfg, '/dsh-voice-api')

    await engine.start({ hold: true })
    for (let i = 0; i < 10; i++) audio.tick(0.25) // speech
    // 3.2s of silence — past SILENCE_TIMEOUT_MS, which would flush in tap mode
    for (let i = 0; i < 50; i++) audio.tick(0)
    expect(posts).toHaveLength(0)

    await engine.stop()
    await settle()
    expect(posts).toHaveLength(1)
  })

  it('still reports the speech edge for barge-in', async () => {
    installFetchCapture()
    const engine = createAsrEngine(cfg, '/dsh-voice-api')
    const edges: number[] = []
    engine.onSpeechStart(() => edges.push(1))

    await engine.start({ hold: true })
    audio.tick(0) // silence must not trigger the edge
    expect(edges).toHaveLength(0)
    audio.tick(0.25) // speech does
    expect(edges).toHaveLength(1)
    audio.tick(0.25) // and only on the leading edge
    expect(edges).toHaveLength(1)
    await engine.cancel()
  })

  it('streams mic levels for the waveform', async () => {
    installFetchCapture()
    const engine = createAsrEngine(cfg, '/dsh-voice-api')
    const levels: number[] = []
    engine.onLevel((l) => levels.push(l))

    await engine.start({ hold: true })
    audio.tick(0)
    audio.tick(0.25) // at LEVEL_CEILING -> full-height bar
    await engine.cancel()

    expect(levels).toHaveLength(2)
    expect(levels[0]).toBe(0)
    expect(levels[1]).toBeCloseTo(1, 5)
  })

  it('resets to idle when the mic is denied', async () => {
    installFetchCapture()
    ;(globalThis.navigator as { mediaDevices: { getUserMedia: unknown } }).mediaDevices
      .getUserMedia = async () => { throw new Error('Permission denied') }
    const engine = createAsrEngine(cfg, '/dsh-voice-api')

    await expect(engine.start({ hold: true })).rejects.toThrow('Permission denied')
    expect(engine.state).toBe('idle')
  })
})

/**
 * Interim transcripts (the live caption in the press-to-talk overlay).
 *
 * SenseVoice is not a streaming model, so a preview means re-decoding the
 * whole buffer: the engine only pays for it while a caption is listening, and
 * an interim must never be mistaken for the final transcript.
 */
describe('interim transcripts', () => {
  let audio: { tick(a: number): void }
  beforeEach(() => { audio = installFakeAudio() })

  /** 1024 samples @ 16kHz = 64ms, so 15 ticks clears the 900ms interval. */
  const TICKS_PER_INTERVAL = 15

  it('previews the capture so far while the hold is open', async () => {
    const posts = installFetchCapture('你好')
    const engine = createAsrEngine(cfg, '/dsh-voice-api')
    const partials: string[] = []
    const finals: string[] = []
    engine.onPartial((t) => partials.push(t))
    engine.onSegment((t) => finals.push(t))

    await engine.start({ hold: true })
    for (let i = 0; i < TICKS_PER_INTERVAL; i++) audio.tick(0.2)
    await settle()

    expect(posts).toHaveLength(1)
    expect(partials).toEqual(['你好'])
    // an interim is a preview: it must not reach the composer draft
    expect(finals).toEqual([])

    await engine.cancel()
  })

  it('asks for nothing while no caption is listening', async () => {
    const posts = installFetchCapture('你好')
    const engine = createAsrEngine(cfg, '/dsh-voice-api')

    await engine.start({ hold: true })
    for (let i = 0; i < TICKS_PER_INTERVAL * 3; i++) audio.tick(0.2)
    await settle()

    expect(posts).toHaveLength(0)
    await engine.cancel()
  })

  it('leaves tap mode without interim passes', async () => {
    const posts = installFetchCapture('你好')
    const engine = createAsrEngine(cfg, '/dsh-voice-api')
    engine.onPartial(() => {})

    await engine.start() // tap mode: the VAD owns segmentation
    for (let i = 0; i < TICKS_PER_INTERVAL * 2; i++) audio.tick(0.2)
    await settle()

    expect(posts).toHaveLength(0)
    await engine.cancel()
  })

  it('never lets a late interim land after the release', async () => {
    // The interim is still in flight when the user lets go; its answer
    // describes a capture the UI has already moved past.
    let unblock: (() => void) | null = null
    const bodies: number[] = []
    vi.stubGlobal('fetch', async (_url: string, init: { body: ArrayBuffer }) => {
      bodies.push(init.body.byteLength)
      const first = bodies.length === 1
      if (first) await new Promise<void>((r) => { unblock = r })
      return {
        ok: true,
        status: 200,
        json: async () => ({ text: first ? '半句' : '完整的一句话' }),
      }
    })
    const engine = createAsrEngine(cfg, '/dsh-voice-api')
    const partials: string[] = []
    const finals: string[] = []
    engine.onPartial((t) => partials.push(t))
    engine.onSegment((t) => finals.push(t))

    await engine.start({ hold: true })
    for (let i = 0; i < TICKS_PER_INTERVAL; i++) audio.tick(0.2)
    await settle()
    expect(bodies).toHaveLength(1) // interim fired and is pending

    await engine.stop()
    await settle()
    unblock?.()
    await settle()

    expect(finals).toEqual(['完整的一句话'])
    expect(partials).toEqual([])
  })
})

/**
 * Final-pass serialization.
 *
 * A segment can be finalized while the previous one is still in flight (short
 * pauses in continuous dictation, or a 30s cap flush). Dropping it — the old
 * `if (transcribing) return` — loses that speech entirely.
 */
describe('queued final segments', () => {
  let audio: { tick(a: number): void }
  beforeEach(() => { audio = installFakeAudio() })

  it('transcribes a segment that finishes while the previous POST is in flight', async () => {
    let releaseFirst: (() => void) | null = null
    let calls = 0
    vi.stubGlobal('fetch', async (_url: string, _init: { body: ArrayBuffer }) => {
      const n = ++calls
      if (n === 1) await new Promise<void>((r) => { releaseFirst = r })
      return { ok: true, status: 200, json: async () => ({ text: `第${n}段` }) }
    })
    const engine = createAsrEngine(cfg, '/dsh-voice-api')
    const seen: string[] = []
    engine.onSegment((t) => seen.push(t))

    await engine.start()
    // Segment 1: 2.24s of speech + >2s trailing silence flushes it.
    for (let i = 0; i < 35; i++) audio.tick(0.25)
    for (let i = 0; i < 40; i++) audio.tick(0)
    await settle()
    expect(calls).toBe(1) // first request is held open

    // Segment 2 finalizes while segment 1 is still in flight: it must queue,
    // not vanish.
    for (let i = 0; i < 35; i++) audio.tick(0.25)
    for (let i = 0; i < 40; i++) audio.tick(0)
    await settle()
    expect(calls).toBe(1)

    releaseFirst?.()
    await settle()
    await settle()
    await settle()
    expect(calls).toBe(2)
    expect(seen).toEqual(['第1段', '第2段'])

    await engine.stop()
  })

  it('cancel drops queued passes and discards the in-flight transcript', async () => {
    let release: (() => void) | null = null
    vi.stubGlobal('fetch', async () => {
      await new Promise<void>((r) => { release = r })
      return { ok: true, status: 200, json: async () => ({ text: '不该出现' }) }
    })
    const engine = createAsrEngine(cfg, '/dsh-voice-api')
    const seen: string[] = []
    engine.onSegment((t) => seen.push(t))

    await engine.start({ hold: true })
    for (let i = 0; i < 30; i++) audio.tick(0.25)
    await engine.stop() // final pass starts, then stays in flight
    await settle()
    expect(release).not.toBeNull()

    await engine.start({ hold: true }) // a new capture begins
    await engine.cancel() // and is discarded
    release?.()
    await settle()

    expect(seen).toEqual([])
    expect(engine.state).toBe('idle')
  })
})

describe('incremental interim transcripts', () => {
  let audio: { tick(a: number): void }
  beforeEach(() => { audio = installFakeAudio() })
  const TICKS_PER_INTERVAL = 15

  it('sends only the delta since the previous pass, with a session header', async () => {
    // Track headers + body byte lengths for each interim POST.
    const calls: { bytes: number; session?: string }[] = []
    vi.stubGlobal('fetch', async (_url: string, init: { body: ArrayBuffer; headers: Record<string, string> }) => {
      calls.push({ bytes: init.body.byteLength, session: init.headers['x-dsh-session'] })
      return { ok: true, status: 200, json: async () => ({ text: '你好' }) }
    })
    const engine = createAsrEngine(cfg, '/dsh-voice-api')
    engine.onPartial(() => {})

    await engine.start({ hold: true })
    // First interim pass: ~0.96s of audio.
    for (let i = 0; i < TICKS_PER_INTERVAL; i++) audio.tick(0.2)
    // Let the whole fetch chain (await fetch + await json + delta bookkeeping)
    // settle before the next interval, or the second pass re-sends everything.
    await settle()
    await settle()
    expect(calls).toHaveLength(1)
    const firstBytes = calls[0].bytes
    expect(firstBytes).toBeGreaterThan(0)
    // Incremental: each pass must carry the session correlation header.
    expect(calls[0].session).toBeTruthy()

    // Second pass: only the new ticks should go over the wire (delta < total).
    for (let i = 0; i < TICKS_PER_INTERVAL; i++) audio.tick(0.2)
    await settle()
    await settle()
    expect(calls).toHaveLength(2)
    // The second delta must be strictly smaller than the whole capture and
    // carry the same session id.
    expect(calls[1].bytes).toBeLessThan(firstBytes * 2)
    expect(calls[1].session).toBe(calls[0].session)

    await engine.cancel()
  })
})

// A TTS echo reference lives in the page's playback AudioContext; the capture
// context is a separate 16kHz one, so `ref.connect(processor)` throws
// InvalidStateError. The recorder must fall back to browser AEC instead of
// failing the whole capture ("麦克风不可用").
describe('echo reference across AudioContexts', () => {
  it('falls back to browser AEC when the reference belongs to another context', async () => {
    const audio = installFakeAudio()
    const posts = installFetchCapture('跨上下文也没关系')
    const foreign = {
      context: {},
      connect() {
        throw new Error('cannot connect to a node in a different context')
      },
    }
    const engine = createAsrEngine(cfg, '/dsh-voice-api', () => ({ node: foreign as never }))
    const seen: string[] = []
    engine.onSegment((t) => seen.push(t))

    await engine.start({ hold: true })
    for (let i = 0; i < 12; i++) audio.tick(0.05) // ~0.77s, above the mis-tap floor
    await engine.stop()
    await settle()

    const request = audio.constraints() as { audio: { echoCancellation: boolean } }
    expect(request.audio.echoCancellation).toBe(true)
    expect(posts).toHaveLength(1)
    expect(seen).toEqual(['跨上下文也没关系'])
  })

  it('keeps the NLMS path when the reference shares the capture context', async () => {
    const audio = installFakeAudio()
    installFetchCapture('AEC 可用')
    const connect = vi.fn()
    const engine = createAsrEngine(cfg, '/dsh-voice-api', () => ({
      node: { context: audio.ctx, connect } as never,
    }))

    await engine.start({ hold: true })
    for (let i = 0; i < 12; i++) audio.tick(0.05)
    await engine.stop()
    await settle()

    const request = audio.constraints() as { audio: { echoCancellation: boolean } }
    expect(request.audio.echoCancellation).toBe(false)
    expect(connect).toHaveBeenCalled()
  })
})
