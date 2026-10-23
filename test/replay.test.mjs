// Message replay: the host reads the assistant text from the session store,
// applies the same tts.mode policy, and answers with MP3 bytes.
import { apply } from '../lib/index.js'

const routes = []
const ctx = {
  on() {},
  effect(fn) {
    const r = fn()
    return r ?? (() => {})
  },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
  get(name) {
    if (name !== 'sessions') return undefined
    return {
      get(id) {
        if (id !== 'sess-1') return undefined
        return {
          deriveMessages() {
            return [
              { id: 'msg-text', role: 'assistant', content: [{ type: 'text', text: '第一句。第二句。' }] },
              { id: 'msg-empty', role: 'assistant', content: [{ type: 'reasoning', text: '思考' }] },
            ]
          },
        }
      },
    }
  },
}

apply(ctx, {
  basePath: '/dsh-voice-api',
  voice: 'zh-CN-XiaoxiaoNeural',
  enabled: true,
  cacheDir: '/tmp/dsh-voice-test-cache',
  asr: { model: 'x', modelHost: 'https://huggingface.co', language: 'auto', useItn: true, autoSend: true, mode: 'toggle', hotkey: 'Control', silenceMs: 1000, energyThreshold: 0.015 },
  tts: { mode: 'all' },
})

const replay = routes.find((r) => r.path === '/dsh-voice-api/replay')
if (!replay) throw new Error('replay route missing')

function call(body) {
  return new Promise((resolve) => {
    const listeners = {}
    const req = {
      method: 'POST',
      on(event, fn) {
        listeners[event] = fn
        return req
      },
    }
    const chunks = []
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) {
        this.headers[k] = v
      },
      end(data) {
        resolve({ status: this.statusCode, headers: this.headers, body: data })
      },
    }
    replay.handler(req, res)
    listeners.data?.(Buffer.from(JSON.stringify(body)))
    listeners.end?.()
  })
}

// 1. known message → MP3
{
  const out = await call({ sessionId: 'sess-1', messageId: 'msg-text' })
  if (out.status !== 200) throw new Error(`expected 200, got ${out.status}`)
  if (out.headers['content-type'] !== 'audio/mpeg') throw new Error('wrong content-type')
  const bytes = Buffer.isBuffer(out.body) ? out.body : Buffer.from(out.body ?? [])
  if (bytes.length < 1000) throw new Error(`audio too small: ${bytes.length}`)
  if (bytes[0] !== 0xff) throw new Error('not an MP3 frame')
  console.log('  ok  replay returns MP3 for a known message')
}

// 2. message with no text → 204
{
  const out = await call({ sessionId: 'sess-1', messageId: 'msg-empty' })
  if (out.status !== 204) throw new Error(`expected 204, got ${out.status}`)
  console.log('  ok  replay answers 204 when the message has no text')
}

// 3. unknown session → 404
{
  const out = await call({ sessionId: 'nope', messageId: 'msg-text' })
  if (out.status !== 404) throw new Error(`expected 404, got ${out.status}`)
  console.log('  ok  replay answers 404 for an unknown session')
}

console.log('\nALL REPLAY TESTS PASSED')
process.exit(0)
