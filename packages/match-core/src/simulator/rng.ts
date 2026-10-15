/**
 * Deterministic PRNG (mulberry32). The generator must produce
 * byte-identical fixtures for identical seeds across platforms, so
 * `Math.random` is never used anywhere in the simulator.
 */
export class SeededRng {
  private state: number;

  constructor(readonly seed: number) {
    if (!Number.isSafeInteger(seed) || seed < 0) {
      throw new RangeError(`seed must be a non-negative safe integer, got ${String(seed)}`);
    }
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Symmetric zero-mean jitter bounded by ±amplitude. */
  jitter(amplitude: number): number {
    return (this.next() * 2 - 1) * amplitude;
  }
}
