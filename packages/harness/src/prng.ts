// Seeded PRNG: splitmix32 for seeding, xoshiro128** for draws, with derived
// per-concern streams (workload/network/faults/…) so adding a draw in one
// concern never perturbs another — the property that keeps failing seeds
// stable across code changes (ADR-002 of raftlab lineage; approved plan).

const splitmix32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return (t = t ^ (t >>> 15)) >>> 0;
  };
};

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [0, n). */
  int(n: number): number;
  /** Pick one element. */
  pick<T>(arr: readonly T[]): T;
  /** True with probability p. */
  chance(p: number): boolean;
}

const xoshiro128ss = (s0: number, s1: number, s2: number, s3: number): (() => number) => {
  let [a, b, c, d] = [s0 >>> 0, s1 >>> 0, s2 >>> 0, s3 >>> 0];
  const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;
  return () => {
    const result = (Math.imul(rotl(Math.imul(b, 5) >>> 0, 7), 9) >>> 0);
    const t = (b << 9) >>> 0;
    c ^= a;
    d ^= b;
    b ^= c;
    a ^= d;
    c ^= t;
    d = rotl(d, 11);
    return result;
  };
};

const fromU32 = (u32: () => number): Rng => ({
  next: () => u32() / 4294967296,
  int: (n) => u32() % n,
  pick: (arr) => arr[u32() % arr.length] as never,
  chance: (p) => u32() / 4294967296 < p,
});

/** Root of a seed's stream tree. */
export const createRoot = (seed: number): { stream: (label: string) => Rng } => {
  return {
    stream(label: string): Rng {
      // Mix the label into the seed so streams are independent and stable.
      let h = seed >>> 0;
      for (const ch of label) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
      const mix = splitmix32(h);
      return fromU32(xoshiro128ss(mix(), mix(), mix(), mix()));
    },
  };
};

/** FNV-1a over strings — the trace hash for determinism checks. */
export const fnv1a = (parts: Iterable<string>): number => {
  let h = 0x811c9dc5;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      h = Math.imul(h ^ part.charCodeAt(i), 0x01000193) >>> 0;
    }
  }
  return h >>> 0;
};
