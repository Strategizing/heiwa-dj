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

export const FALLBACK_GROOVE = 'setcpm(124); stack(s("bd*4"), s("~ cp ~ cp"), s("hh*8").gain(0.45))'

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
