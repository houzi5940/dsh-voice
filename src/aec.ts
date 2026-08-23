/**
 * NLMS (normalized least-mean-squares) acoustic echo canceller.
 *
 * The browser's `echoCancellation` constraint is a black box: quality varies
 * by OS/browser and it cannot see what *this* page is playing. When the TTS
 * voice is loud, playback bleeds into the mic and falsely trips the barge-in
 * VAD. This module runs a second, explicit echo canceller on the mic signal
 * using the page's own TTS output as the reference — so the canceller is
 * always aligned with exactly what the assistant said, not an OS guess.
 *
 * Algorithm: standard NLMS with a fixed tap delay + adaptive FIR.
 *   y[n] = w · x[n - D .. n - D - L]   (estimated echo)
 *   e[n] = d[n] - y[n]                 (clean signal)
 *   w   += μ · e[n] · x / (‖x‖² + ε)
 *
 * `d` is the mic (desired) signal, `x` the TTS reference. The filter learns
 * the acoustic path from speaker to mic (delay + room impulse response) and
 * subtracts it from the mic. Pure module — no Web Audio types, unit-testable.
 */

export interface AecOptions {
  /** FIR filter length (taps). Covers speaker->mic delay + early reflections. */
  filterLength?: number
  /**
   * Fixed delay applied to the reference before the filter, in samples.
   * The speaker->mic path has a short OS/buffer latency; a fixed lead-in
   * lets a shorter filter still cover the tail.
   */
  delay?: number
  /** Normalized step size (0 < μ < 2; ~0.1 is a safe default). */
  step?: number
  /** Regularizer on the denominator to avoid div-by-zero on silence. */
  epsilon?: number
}

const DEFAULT_FILTER_LENGTH = 256
const DEFAULT_DELAY = 64
const DEFAULT_STEP = 0.1
const DEFAULT_EPSILON = 1e-6

export class NlmsAec {
  private readonly w: Float32Array
  private readonly xBuf: Float32Array
  private readonly filterLength: number
  private readonly delay: number
  private readonly mu: number
  private readonly eps: number
  /** Ring cursor into xBuf (reference history). */
  private cursor = 0
  /** How many reference samples we have buffered so far (for warm-up). */
  private filled = 0

  constructor(options: AecOptions = {}) {
    this.filterLength = options.filterLength ?? DEFAULT_FILTER_LENGTH
    this.delay = options.delay ?? DEFAULT_DELAY
    this.mu = options.step ?? DEFAULT_STEP
    this.eps = options.epsilon ?? DEFAULT_EPSILON
    this.w = new Float32Array(this.filterLength)
    // Enough history for delay + filter span.
    this.xBuf = new Float32Array(this.delay + this.filterLength)
  }

  /**
   * Push the next mic/reference block; returns the echo-removed mic samples
   * (same length as the input). Reference may be shorter than the mic block
   * (e.g. silence pad) — it is zero-filled to the block length.
   */
  process(mic: Float32Array, ref: Float32Array): Float32Array {
    const n = mic.length
    const out = new Float32Array(n)
    if (n === 0) return out

    const xBuf = this.xBuf
    const bufLen = xBuf.length
    let cursor = this.cursor

    for (let i = 0; i < n; i++) {
      // Write the reference sample into the history ring.
      xBuf[cursor] = i < ref.length ? ref[i] : 0
      cursor = (cursor + 1) % bufLen
      this.filled = Math.min(this.filled + 1, bufLen)

      // Read the delayed reference window for this sample.
      // Index of x[n - delay] in the ring.
      const d = mic[i]
      if (this.filled >= this.delay + this.filterLength) {
        let y = 0
        let norm = 0
        let idx = (cursor - this.delay + bufLen) % bufLen
        for (let t = 0; t < this.filterLength; t++) {
          const x = xBuf[idx]
          y += this.w[t] * x
          norm += x * x
          idx = (idx - 1 + bufLen) % bufLen
        }
        const e = d - y
        out[i] = e
        // NLMS weight update.
        const denom = norm + this.eps
        const gain = (this.mu * e) / denom
        idx = (cursor - this.delay + bufLen) % bufLen
        for (let t = 0; t < this.filterLength; t++) {
          this.w[t] += gain * xBuf[idx]
          idx = (idx - 1 + bufLen) % bufLen
        }
      } else {
        // Warm-up: not enough reference history yet, pass mic through.
        out[i] = d
      }
    }
    this.cursor = cursor
    return out
  }

  /** Reset adaptation (call on start/stop to avoid stale speaker->mic path). */
  reset(): void {
    this.w.fill(0)
    this.xBuf.fill(0)
    this.cursor = 0
    this.filled = 0
  }
}
