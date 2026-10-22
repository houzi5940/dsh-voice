// TTS retry/backoff test.
//
// When the Edge TTS handshake fails (offline, blocked network, upstream 403)
// the queue must not re-enter the pump immediately: that used to spin a hot
// loop of WebSocket attempts. This drives a permanently failing handshake and
// asserts the attempt rate is backoff-shaped.
import { MsEdgeTTS } from 'msedge-tts'

let attempts = 0
MsEdgeTTS.prototype.setMetadata = () => {
  attempts++
  return Promise.reject(new Error('offline'))
}

const { TtsQueue } = await import('../lib/tts-queue.js')

let failures = 0
function assert(cond, label) {
  if (cond) {
    console.log(`  ok  ${label}`)
  } else {
    failures++
    console.error(`FAIL  ${label}`)
  }
}

const warn = console.warn
console.warn = () => {}
const queue = new TtsQueue()
queue.enqueue('sess-retry', '这句话暂时说不出来。')

await new Promise((r) => setTimeout(r, 1200))
console.warn = warn

// Attempt #1 at t=0, the first retry after RETRY_BASE_MS (1s): 2 attempts in
// this window. The pre-backoff implementation produced hundreds.
assert(attempts >= 1, `pump attempted the handshake (${attempts})`)
assert(attempts <= 3, `handshake is backed off, not hot-looped (${attempts} attempts in 1.2s)`)

try {
  await queue.close()
} catch {
  // the handshake never opened a socket; close is best-effort
}

console.log(failures === 0 ? '\nALL TTS RETRY TESTS PASSED' : `\n${failures} TEST(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
