/**
 * Deterministic synthetic fixtures (PLAN §8.5). No randomness: every value is
 * hand-checkable from the definitions below.
 */
import type { StreamSample } from '../stream';

export interface Segment {
  sec: number;
  watts: number | null;
  hr: number | null;
}

/** 1 Hz stream built from back-to-back constant segments, starting at t = t0. */
export function segments(segs: readonly Segment[], t0 = 0): StreamSample[] {
  const out: StreamSample[] = [];
  let t = t0;
  for (const s of segs) {
    for (let i = 0; i < s.sec; i++) out.push({ t: t++, watts: s.watts, hr: s.hr });
  }
  return out;
}

export function steadyRide(sec: number, watts: number, hr: number, t0 = 0): StreamSample[] {
  return segments([{ sec, watts, hr }], t0);
}

/**
 * "Junk miles": a repeating 80 s pattern of 10 s blocks, every block well under 300 W.
 * Mean of the pattern = (100+160+220+130+0+190+140+170)/8 = 138.75 W.
 */
export const JUNK_PATTERN = [100, 160, 220, 130, 0, 190, 140, 170] as const;

export function junk(sec: number, hr: number): Segment[] {
  const segs: Segment[] = [];
  for (let i = 0; i * 10 < sec; i++) {
    segs.push({ sec: Math.min(10, sec - i * 10), watts: JUNK_PATTERN[i % 8]!, hr });
  }
  return segs;
}
