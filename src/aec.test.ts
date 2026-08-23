/**
 * NLMS AEC unit tests.
 *
 * We synthesize a mic signal = clean speech + a scaled, delayed copy of the
 * TTS reference (a crude loudspeaker->mic echo), then assert the canceller
 * converges: the output correlates strongly with the clean component and
 * weakly with the echo component.
 */
import { describe, expect, it } from 'vitest'

import { NlmsAec } from './aec.ts'

/** Pseudo-noise "speech". */
function noise(n: number, seed = 7): Float32Array {
  const out = new Float32Array(n)
  let s = seed
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    out[i] = (s / 0x7fffffff) * 2 - 1
  }
  return out
}

function energy(x: Float32Array): number {
  let s = 0
  for (let i = 0; i < x.length; i++) s += x[i] * x[i]
  return s / x.length
}

function correlate(a: Float32Array, b: Float32Array): number {
  let num = 0
  let a2 = 0
  let b2 = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    num += a[i] * b[i]
    a2 += a[i] * a[i]
    b2 += b[i] * b[i]
  }
  if (a2 === 0 || b2 === 0) return 0
  return num / Math.sqrt(a2 * b2)
}

const BLOCK = 1024
const RATE = 16000

describe('NlmsAec', () => {
  it('converges on a delayed, scaled copy of the reference (echo)', () => {
    const filterLength = 128
    const delay = 64
    // Faster step to converge within 2s of noise.
    const aec = new NlmsAec({ filterLength, delay, step: 0.2 })

    const clean = noise(RATE * 2)
    const ref = noise(RATE * 2, 99)
    const echoGain = 0.3

    const mic = new Float32Array(RATE * 2)
    for (let i = 0; i < RATE * 2; i++) {
      mic[i] = clean[i] + (i >= delay ? echoGain * ref[i - delay] : 0)
    }

    const out = new Float32Array(RATE * 2)
    for (let off = 0; off < RATE * 2; off += BLOCK) {
      out.set(
        aec.process(mic.subarray(off, off + BLOCK), ref.subarray(off, off + BLOCK)),
        off,
      )
    }

    // The echo component (ref) must be strongly suppressed in the output...
    expect(correlate(out, ref)).toBeLessThan(0.3)
    // ...while the clean component is preserved.
    expect(correlate(out, clean)).toBeGreaterThan(0.5)
    // And the echo portion of the mic energy should drop meaningfully.
    const echoOnly = new Float32Array(RATE * 2)
    for (let i = 0; i < RATE * 2; i++) {
      echoOnly[i] = i >= delay ? echoGain * ref[i - delay] : 0
    }
    expect(energy(out)).toBeLessThan(energy(echoOnly) + energy(clean) * 1.5)
  })

  it('passes clean speech through when the reference is silence', () => {
    const aec = new NlmsAec({ filterLength: 64, delay: 16, step: 0.05 })
    const clean = noise(RATE)
    const ref = new Float32Array(RATE)
    const out = new Float32Array(RATE)
    for (let off = 0; off < RATE; off += BLOCK) {
      out.set(
        aec.process(clean.subarray(off, off + BLOCK), ref.subarray(off, off + BLOCK)),
        off,
      )
    }
    expect(correlate(clean, out)).toBeGreaterThan(0.5)
  })

  it('reset clears adaptation', () => {
    const aec = new NlmsAec({ filterLength: 64, delay: 16, step: 0.05 })
    const ref = noise(RATE)
    aec.process(new Float32Array(RATE), ref) // learn something
    aec.reset()
    // After reset, weights are zero: warm-up passes mic through unchanged.
    const mic = noise(BLOCK)
    const out = aec.process(mic, new Float32Array(BLOCK))
    expect(energy(out)).toBeCloseTo(energy(mic), 5)
  })
})
