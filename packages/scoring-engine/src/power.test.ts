import { describe, expect, it } from 'vitest';
import { junk, segments, steadyRide } from './__fixtures__/streams';
import {
  NP_ROLLING_WINDOW_SEC,
  PEAK20_WINDOW_SEC,
  normalizedPower,
  normalizedPowerFromGrid,
  peakWindow,
} from './power';
import type { StreamSample } from './stream';

describe('normalizedPower', () => {
  it('equals the power of a perfectly steady ride', () => {
    expect(normalizedPower(steadyRide(3600, 200, 140))).toBeCloseTo(200, 9);
  });

  it('matches a hand-computed value on a 31 s stream', () => {
    // 30 s @ 200 W then 1 s @ 230 W → rolling 30 s averages: 200 and (29·200 + 230)/30 = 201.
    // NP = ((200⁴ + 201⁴) / 2)^¼ = (1 616 120 400.5)^¼ = 200.50187029995817
    const s = segments([
      { sec: 30, watts: 200, hr: 140 },
      { sec: 1, watts: 230, hr: 140 },
    ]);
    expect(normalizedPower(s)).toBeCloseTo(200.50187029995817, 9);
  });

  it('matches a hand-computed value on a 60 s step and exceeds average power', () => {
    // 30 s @ 100 W then 30 s @ 300 W → 31 rolling windows, avg_j = 100 + 200j/30 (j = 0…30).
    // NP = (Σ avg_j⁴ / 31)^¼ = 223.0694887793096; plain average is 200 W.
    const s = segments([
      { sec: 30, watts: 100, hr: 140 },
      { sec: 30, watts: 300, hr: 140 },
    ]);
    expect(normalizedPower(s)).toBeCloseTo(223.0694887793096, 9);
  });

  it('needs at least one full 30 s window', () => {
    expect(normalizedPowerFromGrid(new Array(NP_ROLLING_WINDOW_SEC - 1).fill(200))).toBeNull();
    expect(normalizedPowerFromGrid(new Array(NP_ROLLING_WINDOW_SEC).fill(200))).toBeCloseTo(200, 9);
  });

  it('gives the same answer for 2 Hz and 1 Hz recordings of the same ride', () => {
    const oneHz = segments([
      { sec: 60, watts: 150, hr: 130 },
      { sec: 60, watts: 250, hr: 150 },
    ]);
    // Drop the trailing half-sample so both streams span exactly 120 s.
    const twoHz: StreamSample[] = oneHz.flatMap((p) => [p, { ...p, t: p.t + 0.5 }]).slice(0, -1);
    expect(normalizedPower(twoHz)).toBeCloseTo(normalizedPower(oneHz)!, 9);
  });

  it('honours maxGapSec when resampling', () => {
    // 30 s @ 300 W, a 20 s recording gap, then 30 s @ 100 W.
    const s = [...steadyRide(30, 300, 150), ...steadyRide(30, 100, 120, 50)];
    // Collapsed (default 10 s): 60 active seconds, the same as the 60 s step test mirrored.
    expect(normalizedPower(s)).toBeCloseTo(223.0694887793096, 9);
    // Held (maxGapSec 30): the last 300 W sample holds for 21 s, so NP rises.
    expect(normalizedPower(s, { maxGapSec: 30 })!).toBeGreaterThan(223.07);
  });
});

describe('peakWindow', () => {
  // PLAN §8.5 fixture: a clear 20-minute threshold effort embedded in junk miles.
  const thresholdRide = segments([
    ...junk(900, 125),
    { sec: 1200, watts: 300, hr: 165 },
    ...junk(1500, 130),
  ]);

  it('isolates a 20-minute threshold effort embedded in junk miles, exactly', () => {
    const w = peakWindow(thresholdRide, PEAK20_WINDOW_SEC)!;
    expect(w).toEqual({
      avgPower: 300,
      avgHr: 165,
      hrCoverage: 1,
      startIndex: 900,
      endIndex: 2100,
      startT: 900,
      endT: 2100,
    });
  });

  it('reports HR from the same window, not the whole ride', () => {
    const w = peakWindow(thresholdRide, PEAK20_WINDOW_SEC)!;
    const wholeRideHr = (900 * 125 + 1200 * 165 + 1500 * 130) / 3600; // 140.41…
    expect(w.avgHr).toBe(165);
    expect(w.avgHr).not.toBeCloseTo(wholeRideHr, 0);
  });

  it('reports window times in the original stream clock', () => {
    const shifted = segments([...junk(900, 125), { sec: 1200, watts: 300, hr: 165 }], 5000);
    const w = peakWindow(shifted, PEAK20_WINDOW_SEC)!;
    expect(w.startIndex).toBe(900);
    expect(w.startT).toBe(5900);
    expect(w.endT).toBe(7100);
  });

  it('breaks ties toward the earliest window', () => {
    const w = peakWindow(steadyRide(1300, 200, 140), PEAK20_WINDOW_SEC)!;
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBe(1200);
  });

  it('returns null when the ride is shorter than the window', () => {
    expect(peakWindow(steadyRide(1199, 200, 140), PEAK20_WINDOW_SEC)).toBeNull();
    expect(peakWindow(steadyRide(1200, 200, 140), PEAK20_WINDOW_SEC)).not.toBeNull();
  });

  it('averages HR over HR-present seconds of the window and reports coverage', () => {
    const s = segments([
      { sec: 2, watts: 100, hr: 120 },
      { sec: 2, watts: 400, hr: 170 },
      { sec: 2, watts: 400, hr: null },
      { sec: 2, watts: 100, hr: 120 },
    ]);
    const w = peakWindow(s, 4)!;
    expect(w.startIndex).toBe(2);
    expect(w.avgPower).toBe(400);
    expect(w.avgHr).toBe(170);
    expect(w.hrCoverage).toBe(0.5);
  });

  it('returns a null HR when the window has no HR at all', () => {
    const s = segments([
      { sec: 3, watts: 100, hr: 120 },
      { sec: 3, watts: 400, hr: null },
    ]);
    const w = peakWindow(s, 3)!;
    expect(w.avgHr).toBeNull();
    expect(w.hrCoverage).toBe(0);
  });

  it('can span a collapsed recording gap (endT then reflects wall-clock time)', () => {
    const s = [...steadyRide(600, 250, 150), ...steadyRide(600, 250, 150, 1000)];
    const w = peakWindow(s, PEAK20_WINDOW_SEC)!;
    expect(w.startT).toBe(0);
    expect(w.endT).toBe(1600);
  });

  it('rejects a non-positive or fractional window length', () => {
    expect(() => peakWindow(steadyRide(10, 100, 100), 0)).toThrow(RangeError);
    expect(() => peakWindow(steadyRide(10, 100, 100), 1.5)).toThrow(RangeError);
  });
});
