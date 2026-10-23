import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: pulls the webServer Context merge (ctx.webServer) into scope.
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: chunk/options shapes for the llm/stream waterfall tap.
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { IncomingHttpHeaders, ServerResponse } from 'node:http'
import { PassThrough, Readable } from 'node:stream'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import os from 'node:os'

// sherpa-onnx (k2-fsa, Apache-2.0) ships no TypeScript declarations; type
// the tiny surface we use. SenseVoice is the CN-native ASR we run host-side.
import sherpa_onnx from 'sherpa-onnx'
interface SherpaStream {
  acceptWaveform(sampleRate: number, samples: Float32Array): void
  free(): void
}
interface SherpaRecognizer {
  createStream(): SherpaStream
  decode(stream: SherpaStream): void
  getResult(stream: SherpaStream): { text: string }
  free(): void
}
const { createOfflineRecognizer } = sherpa_onnx as unknown as {
  createOfflineRecognizer(config: Record<string, unknown>): SherpaRecognizer
}

import { ParagraphGate, SentenceSegmenter } from './segmenter.ts'
import { TtsQueue, type VoiceFrame } from './tts-queue.ts'

/**
 * dsh-voice host half: llm/stream tap -> sentence segmentation -> TTS queue
 * -> SSE broadcast to browser clients.
 */
export const name = 'voice'

export const inject = ['webServer']

/**
 * Fixed bootstrap path for `/config`.
 *
 * The client cannot know a custom `basePath` before it has talked to the
 * host, so the config route is always reachable here; every other route is
 * then addressed through the `basePath` the response carries.
 */
const BOOTSTRAP_BASE = '/dsh-voice-api'

/** Plugin config. */
export interface AsrRuntimeConfig {
  /** SenseVoice repo id on the hub (model.int8.onnx + tokens.txt inside). */
  model: string
  /** Upstream model host the `/hf` cache-through proxy fetches from. */
  modelHost: string
  /** SenseVoice language hint: 'auto', 'zh', 'en', 'ja', 'ko', 'yue'. */
  language: string
  /** Apply SenseVoice inverse text normalization (numbers/symbols). */
  useItn: boolean
  autoSend: boolean
  mode: 'toggle' | 'hold'
  /**
   * Keyboard press-to-talk key (a `KeyboardEvent.key` value, e.g. 'Control').
   * Hold it to record, release to send, Escape to discard. Empty disables it.
   */
  hotkey: string
}

export interface TtsRuntimeConfig {
  /**
   * Which sentences reach the synthesizer. The transcript is always complete
   * in the session; this only trims what is spoken aloud.
   *
   * - 'first': speak only the first sentence of each turn (brief spoken
   *   reply, full text stays in the conversation).
   * - 'paragraph': speak the first paragraph (up to the first blank line),
   *   streaming; longer answers stay silent after the opening paragraph.
   * - 'all': speak every sentence (upstream behavior).
   * - 'off': never synthesize; TTS is effectively muted.
   */
  mode: 'first' | 'paragraph' | 'all' | 'off'
}

export interface Config {
  basePath: string
  voice: string
  enabled: boolean
  cacheDir: string
  asr: AsrRuntimeConfig
  tts: TtsRuntimeConfig
}

/**
 * Which fields the plugin-manager settings form may edit live. `volatile()`
 * marks a field editable without remounting the plugin: the Settings service
 * projects exactly these into its `ns = entry.id` form, and writes flow
 * through the profile patch + HMR (configEditor) rather than a restart.
 * Fields not listed here (basePath, cacheDir, asr.model, asr.modelHost,
 * asr.language, asr.useItn) still compose from the patch but are considered
 * bootstrap-level: changing them takes a reload anyway, so the form omits
 * them to avoid writes that appear to do nothing.
 */
export const Config: z<Config> = z.object({
  basePath: z.string().default('/dsh-voice-api'),
  voice: z.string().default('zh-CN-XiaoxiaoNeural').volatile(),
  enabled: z.boolean().default(true).volatile(),
  cacheDir: z.string().default(join(os.homedir(), '.cache', 'dsh-voice', 'models')),
  asr: z
    .object({
      model: z
        .string()
        .default('csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'),
      modelHost: z.string().default('https://huggingface.co'),
      language: z.string().default('auto'),
      useItn: z.boolean().default(true),
      autoSend: z.boolean().default(false).volatile(),
      mode: z.union([z.const('toggle'), z.const('hold')]).default('toggle'),
      hotkey: z.string().default('Control').volatile(),
      /** Silence (ms) that ends a tap-mode segment; lower = snappier sends. */
      silenceMs: z.number().min(200).max(10_000).default(2000).volatile(),
    })
    .default({}),
  tts: z
    .object({
      mode: z
        .union([
          z.const('first'),
          z.const('paragraph'),
          z.const('all'),
          z.const('off'),
        ])
        .default('all')
        .volatile(),
    })
    .default({}),
})

/**
 * Resolve one schemastery volatile cell to its current value.
 *
 * Volatile fields arrive as live cells (a { get } object) so that
 * `loader/volatile-update` writes apply without remounting the plugin;
 * plain values pass through unchanged.
 */
function live<T>(cell: T): T {
  const c = cell as unknown as { get?: () => T }
  return typeof c?.get === 'function' ? c.get() : cell
}

/** Recursively resolve every volatile cell in a config section (for /config). */
function resolveVolatile(node: unknown): unknown {
  if (node === null || typeof node !== 'object') return node
  const c = node as { get?: () => unknown }
  if (typeof c.get === 'function' && Object.keys(c).length <= 2) {
    return resolveVolatile(c.get())
  }
  if (Array.isArray(node)) return node.map(resolveVolatile)
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    out[key] = resolveVolatile(value)
  }
  return out
}

export function apply(ctx: Context, config: Config): void {
  const base = config.basePath.replace(/\/+$/, '') || BOOTSTRAP_BASE

  // --- SSE fan-out: every client connection receives every voice frame. ---
  const clients = new Set<(frame: VoiceFrame) => void>()
  // onDrained closes the idle Edge-TTS websocket once every session queue
  // has emptied: the socket pins the Node event loop open, and without this
  // a quiet host keeps a live TLS connection forever (and plain-node tests
  // hang after the last sentence). The next enqueue lazily reconnects, so
  // latency cost is one handshake at the start of each spoken turn.
  let drained: Promise<void> | null = null
  const queue = new TtsQueue({
    voice: () => live(config.voice) ?? 'zh-CN-XiaoxiaoNeural',
    onDrained: () => {
      drained = queue.close().catch(() => {})
    },
  })
  const unsubscribe = queue.subscribe((frame) => {
    for (const send of clients) {
      try {
        send(frame)
      } catch {
        // dead socket: the close handler removes it
      }
    }
  })
  ctx.effect(() => unsubscribe)

  // --- llm/stream lossless tap: segment and enqueue, never block the model. ---
  const sessionSegmenters = new Map<string, SentenceSegmenter>()
  // Older configs may predate tts.mode; default to speaking everything.
  // tts.mode is volatile: resolve per turn so a settings write applies live.
  const ttsMode = (): TtsRuntimeConfig['mode'] => live(config.tts?.mode) ?? 'all'
  ctx.on('llm/stream', (options: GenerateOptions, next): AsyncIterable<StreamChunk> => {
    const sessionId = options.sessionId
    if (!live(config.enabled) || sessionId === undefined) return next()
    return tapStream(sessionId, next(), queue, sessionSegmenters, ttsMode())
  })

  // --- HTTP surface: SSE stream, cancel, and the wiring ping. ---
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/stream`,
      handler: (req, res: ServerResponse) => {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        })
        res.write('retry: 3000\n\n')
        const send = (frame: VoiceFrame): void => {
          res.write(`event: audio\ndata: ${JSON.stringify(frame)}\n\n`)
        }
        clients.add(send)
        const heartbeat = setInterval(() => {
          res.write(': hb\n')
        }, 25000)
        // A test stub response keeps the process alive for 25s otherwise.
        heartbeat.unref?.()
        const cleanup = (): void => {
          clearInterval(heartbeat)
          clients.delete(send)
        }
        req.on('close', cleanup)
        res.on('close', cleanup)
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/cancel`,
      handler: (req, res) => {
        let body = ''
        req.on('data', (c) => {
          body += c
        })
        req.on('end', () => {
          let sessionId: string | undefined
          try {
            sessionId = JSON.parse(body || '{}').sessionId
          } catch {
            // ignore malformed body
          }
          if (sessionId) queue.cancel(sessionId)
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: true }))
        })
      },
    }),
  )

  const configHandler = (_req: unknown, res: ServerResponse): void => {
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    // Always report the normalized base so the client can build its URLs.
    res.end(JSON.stringify({ asr: resolveVolatile(config.asr), basePath: base }))
  }
  // Serve /config on the configured base AND on the fixed bootstrap path,
  // so a client that does not know a custom basePath can still discover it.
  for (const prefix of new Set([base, BOOTSTRAP_BASE])) {
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${prefix}/config`,
        handler: configHandler,
      }),
    )
  }

  // --- SenseVoice ASR (host-side, via sherpa-onnx). ---
  // The browser records + segments audio and POSTs raw little-endian f32
  // PCM (16 kHz); we run SenseVoice locally. Model files live in cacheDir
  // and are downloaded on demand: sherpa-onnx does NOT throw when the files
  // are absent — it logs "Errors in config" and decodes silence to "", which
  // surfaces as "the mic works but nothing is ever sent". So readiness is
  // checked here, never inferred from the recognizer constructor.
  // Old or hand-written configs may omit these; fall back to the schema
  // defaults instead of crashing apply() on a `join(undefined)`.
  const cacheDir =
    config.cacheDir || join(os.homedir(), '.cache', 'dsh-voice', 'models')
  const modelId =
    config.asr?.model || 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'
  const modelHost = config.asr?.modelHost || 'https://huggingface.co'
  const modelRoot = join(cacheDir, modelId, 'resolve', 'main')
  const modelPath = join(modelRoot, 'model.int8.onnx')
  const tokensPath = join(modelRoot, 'tokens.txt')
  type ModelPhase = {
    state: 'missing' | 'downloading' | 'ready' | 'error'
    received: number
    total: number
    error?: string
  }
  let modelPhase: ModelPhase = { state: 'missing', received: 0, total: 0 }
  let modelTask: Promise<void> | null = null

  const fileSize = async (path: string): Promise<number> => {
    try {
      return (await stat(path)).size
    } catch {
      return 0
    }
  }

  /** Stream one model file into place, resuming a `.part` left by a crash. */
  const downloadModelFile = async (
    name: string,
    dest: string,
    onBytes: (delta: number) => void,
  ): Promise<void> => {
    const base = modelHost.replace(/\/+$/, '')
    const url = `${base}/${modelId}/resolve/main/${name}`
    const part = `${dest}.part`
    const have = await fileSize(part)
    const headers: Record<string, string> = have > 0 ? { range: `bytes=${have}-` } : {}
    const res = await fetch(url, { headers, redirect: 'follow' })
    if (res.status !== 200 && res.status !== 206) {
      throw new Error(`下载 ${name} 失败：HTTP ${res.status}`)
    }
    const append = res.status === 206 && have > 0
    const remaining = Number(res.headers.get('content-length') ?? '0')
    if (append) modelPhase.total = Math.max(modelPhase.total, have + remaining)
    else if (name.endsWith('.onnx')) modelPhase.total = remaining
    const sink = createWriteStream(part, { flags: append ? 'a' : 'w' })
    const reader = res.body?.getReader()
    if (!reader) throw new Error(`下载 ${name} 失败：响应无正文`)
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          if (!sink.write(Buffer.from(value))) {
            await new Promise<void>((resolve) => sink.once('drain', resolve))
          }
          modelPhase.received += value.byteLength
          onBytes(value.byteLength)
        }
      }
    } finally {
      sink.end()
      await new Promise<void>((resolve) => sink.once('close', resolve))
    }
    const got = await fileSize(part)
    if (name.endsWith('.onnx') && got < 10_000_000) {
      throw new Error(`模型文件不完整（${got} 字节）`)
    }
    if (name === 'tokens.txt' && got < 10_000) {
      throw new Error(`词表文件不完整（${got} 字节）`)
    }
    await rename(part, dest)
  }

  /**
   * Make the model files available, downloading once. Concurrent callers
   * share one task; a failed attempt clears it so a later call can retry.
   */
  const ensureModel = async (): Promise<void> => {
    if (modelPhase.state === 'ready') return
    if (modelTask) return modelTask
    modelTask = (async () => {
      const modelBytes = await fileSize(modelPath)
      const tokenBytes = await fileSize(tokensPath)
      if (modelBytes > 10_000_000 && tokenBytes > 10_000) {
        modelPhase = { state: 'ready', received: modelBytes, total: modelBytes }
        return
      }
      modelPhase = { state: 'downloading', received: 0, total: 0 }
      await mkdir(modelRoot, { recursive: true })
      await downloadModelFile('model.int8.onnx', modelPath, () => {})
      await downloadModelFile('tokens.txt', tokensPath, () => {})
      const total = await fileSize(modelPath)
      modelPhase = { state: 'ready', received: total, total }
    })()
      .catch((error) => {
        modelPhase = {
          state: 'error',
          received: modelPhase.received,
          total: modelPhase.total,
          error: error instanceof Error ? error.message : String(error),
        }
        throw error
      })
      .finally(() => {
        modelTask = null
      })
    return modelTask
  }

  // Warm the cache in the background once the plugin mounts; a missing model
  // is the difference between "voice works" and "nothing ever gets sent".
  void ensureModel().catch((error) => {
    console.warn(`[dsh-voice] model download failed: ${String(error)}`)
  })

  let recognizer: SherpaRecognizer | null = null
  const getRecognizer = (): SherpaRecognizer => {
    if (recognizer) return recognizer
    recognizer = createOfflineRecognizer({
      modelConfig: {
        senseVoice: {
          model: modelPath,
          language: config.asr.language,
          useInverseTextNormalization: config.asr.useItn ? 1 : 0,
        },
        tokens: tokensPath,
        numThreads: 4,
        debug: 0,
        provider: 'cpu',
      },
      decodingMethod: 'greedy_search',
    })
    return recognizer
  }

  // Incremental ASR: a live-caption session accumulates a sliding window of
  // audio (bounded below) instead of re-decoding the whole hold each time.
  // SenseVoice is a non-streaming model, but decoding a fixed-size tail costs
  // a bounded amount per interim pass, so preview latency stops growing with
  // hold length.
  const PARTIAL_WINDOW_S = 8
  const PARTIAL_WINDOW_SAMPLES = PARTIAL_WINDOW_S * 16000
  const asrSessions = new Map<string, Float32Array>()
  // Retire sessions older than this; interims are best-effort previews.
  const SESSION_TTL_MS = 60_000
  const asrSessionTouch = new Map<string, number>()
  const touchSession = (id: string): void => {
    asrSessionTouch.set(id, Date.now())
  }
  const sessionSweeper = setInterval(() => {
    const now = Date.now()
    for (const [id, last] of asrSessionTouch) {
      if (now - last > SESSION_TTL_MS) {
        asrSessions.delete(id)
        asrSessionTouch.delete(id)
      }
    }
  }, 30_000)
  sessionSweeper.unref()

  const decodeSamples = (samples: Float32Array): string => {
    const rec = getRecognizer()
    const stream = rec.createStream()
    stream.acceptWaveform(16000, samples)
    rec.decode(stream)
    const text = rec.getResult(stream).text
    stream.free()
    return text
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/asr`,
      handler: (req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          const buf = Buffer.concat(chunks)
          res.setHeader('content-type', 'application/json')
          // Malformed payloads are a client bug regardless of model state.
          if (buf.length % 4 !== 0 || buf.length === 0) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'invalid pcm payload' }))
            return
          }
          // sherpa-onnx silently decodes with missing weights, so a missing
          // model must be refused here — the client retries the same audio.
          if (modelPhase.state !== 'ready') {
            void ensureModel().catch(() => {})
            res.statusCode = 503
            res.end(JSON.stringify({ error: 'model-not-ready', model: modelPhase }))
            return
          }
          const delta = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4)
          const session = String(req.headers['x-dsh-session'] ?? '')
          try {
            let text: string
            if (session !== '') {
              // Incremental interim: append the delta to the session window.
              const prev = asrSessions.get(session) ?? new Float32Array(0)
              const merged = new Float32Array(prev.length + delta.length)
              merged.set(prev, 0)
              merged.set(delta, prev.length)
              // Keep only the tail of the window: enough context for a
              // coherent caption, fixed cost per pass.
              if (merged.length > PARTIAL_WINDOW_SAMPLES) {
                text = decodeSamples(merged.subarray(merged.length - PARTIAL_WINDOW_SAMPLES))
              } else {
                text = decodeSamples(merged)
              }
              asrSessions.set(session, merged)
              touchSession(session)
            } else {
              // Final transcription: decode exactly what was sent.
              text = decodeSamples(delta)
            }
            res.statusCode = 200
            res.end(JSON.stringify({ text }))
          } catch (error) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: String(error) }))
          }
        })
      },
    }),
  )

  // Model readiness for the settings self-check and the manual download
  // button; the client polls this while a download is in flight.
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/status`,
      handler: (_req, res: ServerResponse) => {
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ model: modelPhase, path: modelRoot }))
      },
    }),
  )
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/model`,
      handler: (req, res: ServerResponse) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('POST only')
          return
        }
        req.resume()
        void ensureModel().catch(() => {})
        res.statusCode = 202
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ model: modelPhase }))
      },
    }),
  )

  // --- HuggingFace model proxy with on-disk cache. ---
  // Browsers fetch whisper models cross-origin, but hf-mirror.com (and
  // huggingface.co on some routes) do not send CORS headers on every
  // response path (HTTP/3 edge nodes, 307 redirect targets). Proxying
  // through the host keeps every model download same-origin, which also
  // makes the CN mirror work out of the box.
  //
  // The proxy also acts as a cache-through: complete upstream responses are
  // mirrored into cacheDir (mirroring the HF repo path layout), so after one
  // prefetch pass the browser loads weights straight from local disk.
  const inflight = new Map<string, Promise<void>>()
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: `${base}/hf`,
      handler: (req, res) => {
        const suffix = req.url!.slice(`${base}/hf`.length)
        const rel = decodeURIComponent(suffix.split('?')[0])
          .split('/')
          .filter((s) => s && s !== '.' && s !== '..')
        if (rel.length === 0) {
          res.statusCode = 400
          res.end('bad path')
          return
        }
        const localPath = join(config.cacheDir, ...rel)
        const upstreamUrl = config.asr.modelHost.replace(/\/+$/, '') + suffix
        void serveModel(localPath, upstreamUrl, req.headers, res, inflight)
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: base,
      handler: (_req, res) => {
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, name: 'dsh-voice', enabled: live(config.enabled) }))
      },
    }),
  )

  // --- teardown: release the recognizer, the TTS socket and the sweep timer.
  // A plugin reload would otherwise retain a whole SenseVoice model (hundreds
  // of MB) and an Edge TTS WebSocket per generation.
  ctx.effect(() => () => {
    clearInterval(sessionSweeper)
    recognizer?.free()
    recognizer = null
    void queue.close().catch(() => undefined)
  })
}

/**
 * Lossless passthrough tap: every chunk is yielded unchanged; text deltas
 * additionally feed the session's sentence segmenter and TTS queue.
 */
const MODEL_MIME: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.onnx': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
}

/**
 * Cache-through model server: local hit (with byte-range support) first,
 * otherwise fetch upstream, forward the body, and mirror complete
 * (non-range) 200 responses — or a verified resume — into the on-disk cache.
 */
async function serveModel(
  localPath: string,
  upstreamUrl: string,
  headers: IncomingHttpHeaders,
  res: ServerResponse,
  inflight: Map<string, Promise<void>>,
): Promise<void> {
  const st = await stat(localPath).catch(() => null)
  if (st?.isFile()) {
    serveLocal(localPath, st, headers, res)
    return
  }
  // Resume a partially cached download: ask the upstream for the tail of
  // the file and append it to the .part temp file.
  const partPath = `${localPath}.part`
  const partSt = await stat(partPath).catch(() => null)
  const upstreamHeaders: Record<string, string> = {}
  if (headers.range) upstreamHeaders.range = headers.range
  else if (partSt?.size) upstreamHeaders.range = `bytes=${partSt.size}-`
  let up: Response
  try {
    up = await fetch(upstreamUrl, { headers: upstreamHeaders })
  } catch (error) {
    res.statusCode = 502
    res.end(`upstream fetch failed: ${String(error)}`)
    return
  }
  if (up.status === 416 && partSt?.size) {
    // The .part file already holds the full object (a previous rename
    // failed): promote it and serve from disk.
    await rename(partPath, localPath).catch(() => undefined)
    const st2 = await stat(localPath).catch(() => null)
    if (st2?.isFile()) {
      serveLocal(localPath, st2, headers, res)
      return
    }
  }
  // Append to a partial file ONLY when the upstream honoured exactly the
  // resume offset we asked for. Some mirror edge nodes ignore Range and answer
  // 200 with the whole body; appending that to a .part file produces a corrupt
  // model whose failure only surfaces much later, at load time.
  const resumeFrom = partSt?.size ?? 0
  const contentRange = up.headers.get('content-range')
  const rangeStart = contentRange === null ? NaN : Number(/^bytes (\d+)-/.exec(contentRange)?.[1] ?? NaN)
  const appending = up.status === 206 && resumeFrom > 0 && rangeStart === resumeFrom

  res.statusCode = up.status
  const pass = (name: string): void => {
    const value = up.headers.get(name)
    if (value) res.setHeader(name, value)
  }
  pass('content-type')
  pass('content-range')
  pass('accept-ranges')
  pass('etag')
  // content-length is only trustworthy for non-encoded bodies; fetch()
  // transparently decodes gzip, which would desync the header from bytes.
  if (!up.headers.get('content-encoding')) pass('content-length')
  if (!up.body) {
    res.end()
    return
  }
  const body = Readable.fromWeb(up.body as never)
  // A 206 is only cacheable when it is a verified resume of our own .part
  // file; an unverifiable partial response is streamed but never written.
  const cacheable = (up.status === 200 || appending) && !headers.range && !inflight.has(localPath)
  if (!cacheable) {
    body.pipe(res)
    return
  }
  // Mirror the complete body to disk while streaming it to the client.
  // A PassThrough tee handles backpressure on both sinks; if the client
  // aborts mid-download, the pipe to `res` unpipes and the cache keeps
  // filling from upstream.
  try {
    await mkdir(dirname(localPath), { recursive: true })
  } catch {
    body.pipe(res)
    return
  }
  // Resume appends; anything else starts the temp file over so a mirror that
  // ignored Range cannot leave half of a duplicate object behind.
  const sink = createWriteStream(partPath, appending ? { flags: 'a' } : {})
  const tee = new PassThrough()
  tee.pipe(res)
  tee.pipe(sink)
  body.pipe(tee)
  body.on('error', (error) => tee.destroy(error))
  tee.on('error', () => sink.destroy())
  const done = new Promise<void>((resolve) => {
    sink.on('finish', () => {
      void rename(partPath, localPath)
        .catch(() => unlink(partPath).catch(() => undefined))
        .finally(resolve)
    })
    sink.on('error', () => {
      void unlink(partPath).catch(() => undefined)
      resolve()
    })
  })
  inflight.set(localPath, done)
  await done
  inflight.delete(localPath)
}

/** Serve a cached file, honoring HTTP byte ranges for onnxruntime-web. */
function serveLocal(
  filePath: string,
  st: { size: number },
  headers: IncomingHttpHeaders,
  res: ServerResponse,
): void {
  const type = MODEL_MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  res.setHeader('content-type', type)
  res.setHeader('accept-ranges', 'bytes')
  const range = /^bytes=(\d*)-(\d*)$/.exec(headers.range ?? '')
  if (range) {
    const start = range[1] ? parseInt(range[1], 10) : 0
    const end = range[2] ? Math.min(parseInt(range[2], 10), st.size - 1) : st.size - 1
    if (start > end || start >= st.size) {
      res.statusCode = 416
      res.setHeader('content-range', `bytes */${st.size}`)
      res.end()
      return
    }
    res.statusCode = 206
    res.setHeader('content-length', String(end - start + 1))
    res.setHeader('content-range', `bytes ${start}-${end}/${st.size}`)
    createReadStream(filePath, { start, end }).pipe(res)
    return
  }
  res.statusCode = 200
  res.setHeader('content-length', String(st.size))
  createReadStream(filePath).pipe(res)
}

/**
 * Decide which segmented sentences are worth synthesizing.
 *
 * 'first' speaks only the opening sentence of the turn — the transcript stays
 * complete because the tap passes every chunk through untouched; only the
 * spoken half is trimmed. 'off' mutes synthesis entirely (segmentation still
 * runs so behavior is identical otherwise). 'all' keeps upstream behavior.
 */
function speakable(
  sentences: string[],
  spokenThisTurn: () => boolean,
  mode: TtsRuntimeConfig['mode'],
): string[] {
  if (mode === 'off') return []
  if (mode !== 'first') return sentences
  if (spokenThisTurn() || sentences.length === 0) return []
  return [sentences[0]]
}

async function* tapStream(
  sessionId: string,
  inner: AsyncIterable<StreamChunk>,
  queue: TtsQueue,
  sessionSegmenters: Map<string, SentenceSegmenter>,
  ttsMode: TtsRuntimeConfig['mode'],
): AsyncIterable<StreamChunk> {
  const segmenter = new SentenceSegmenter()
  sessionSegmenters.set(sessionId, segmenter)
  // 'paragraph' needs the raw text to see blank lines, so it swaps the
  // sentence feed for a ParagraphGate that speaks only the first paragraph
  // and streams (it starts synthesizing before the turn ends).
  const gate = ttsMode === 'paragraph' ? new ParagraphGate() : null
  let flushed = false
  let completed = false
  let finishReason: unknown = null
  let spoke = false
  const spokeAlready = (): boolean => spoke
  const flushOnce = (): void => {
    if (flushed) return
    flushed = true
    const tail = gate ? gate.flush() : speakable(segmenter.flush(), spokeAlready, ttsMode)
    for (const s of tail) {
      spoke = true
      queue.enqueue(sessionId, s)
    }
  }
  try {
    for await (const chunk of inner) {
      if (chunk.type === 'text-delta' && chunk.text) {
        const sentences = gate
          ? gate.feed(chunk.text)
          : speakable(segmenter.feed(chunk.text), spokeAlready, ttsMode)
        for (const s of sentences) {
          spoke = true
          queue.enqueue(sessionId, s)
        }
      }
      if (chunk.type === 'finish') finishReason = chunk.reason
      yield chunk
    }
    completed = true
  } finally {
    // Only a turn that actually completed may flush its trailing buffer.
    // A barge-in aborts the turn (the half-sentence is what the user
    // interrupted), and a stream that throws has no known ending either —
    // speaking the fragment would invent the rest of the sentence.
    const aborted =
      finishReason !== null &&
      typeof finishReason === 'object' &&
      (finishReason as { kind?: unknown }).kind === 'aborted'
    if (completed && !aborted) flushOnce()
    sessionSegmenters.delete(sessionId)
  }
}
