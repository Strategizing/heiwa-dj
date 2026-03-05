export type BreakerBucket = 'syntax' | 'bridge_timeout' | 'model_timeout'

interface Bucket {
  state: 'closed' | 'open' | 'half-open'
  failures: number
  successes: number
  openedAtPhrase: number | null
}

const OPEN_AT: Record<BreakerBucket, number> = {
  syntax: 3,
  bridge_timeout: 2,
  model_timeout: 2
}

export const FALLBACK_GROOVE = [
  'setcpm(140)',
  '$: stack(',
  '  s("bd(5,8)").slow(2).gain(0.95),',
  '  s("sd ~ sd ~").slow(2).gain(0.72),',
  '  note("<0 -2 -3 -5>").slow(2)',
  '    .s("sawtooth")',
  '    .fm(sine.range(18, 64).fast(4))',
  '    .fmh(sine.range(0.2, 1.8).fast(8))',
  '    .lpf(sine.range(120, 900).fast(4))',
  '    .lpq(sine.range(15, 30).fast(6))',
  '    .shape(0.72)',
  '    .distort(0.38)',
  '    .crush(6)',
  '    .gain(0.7),',
  '  s("hh*16").gain(0.2)',
  ')'
].join('\n')

export class CircuitBreaker {
  private buckets: Record<BreakerBucket, Bucket> = {
    syntax: { state: 'closed', failures: 0, successes: 0, openedAtPhrase: null },
    bridge_timeout: { state: 'closed', failures: 0, successes: 0, openedAtPhrase: null },
    model_timeout: { state: 'closed', failures: 0, successes: 0, openedAtPhrase: null }
  }

  advancePhrase(currentPhrase: number): void {
    for (const bucketName of Object.keys(this.buckets) as BreakerBucket[]) {
      const b = this.buckets[bucketName]
      if (b.state === 'open' && b.openedAtPhrase !== null && currentPhrase >= b.openedAtPhrase + 2) {
        b.state = 'half-open'
        b.failures = 0
        b.successes = 0
      }
    }
  }

  recordFailure(bucket: BreakerBucket, currentPhrase: number): void {
    const b = this.buckets[bucket]
    b.failures += 1
    b.successes = 0

    if (b.state === 'half-open') {
      b.state = 'open'
      b.openedAtPhrase = currentPhrase
      b.failures = OPEN_AT[bucket]
      return
    }

    if (b.state === 'closed' && b.failures >= OPEN_AT[bucket]) {
      b.state = 'open'
      b.openedAtPhrase = currentPhrase
    }
  }

  recordSuccess(bucket: BreakerBucket): void {
    const b = this.buckets[bucket]
    if (b.state === 'closed') {
      b.failures = 0
      return
    }

    if (b.state === 'half-open') {
      b.successes += 1
      if (b.successes >= 2) {
        b.state = 'closed'
        b.failures = 0
        b.successes = 0
        b.openedAtPhrase = null
      }
    }
  }

  shouldFallbackNow(): boolean {
    return (Object.values(this.buckets).some((b) => b.state === 'open'))
  }

  getState(): Record<BreakerBucket, { state: string; failures: number; successes: number; openedAtPhrase: number | null }> {
    return {
      syntax: { ...this.buckets.syntax },
      bridge_timeout: { ...this.buckets.bridge_timeout },
      model_timeout: { ...this.buckets.model_timeout }
    }
  }
}
