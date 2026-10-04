import { describe, expect, it } from 'vitest';
import type { BaselineResult } from './baseline';
import { DEFAULT_CLASSIFIER_CONFIG, classifyFatigueFitness, recoveryTrend } from './classifier';
import { DEFAULT_DERIVER_ID, PEAK20_V1, createDeriverRegistry } from './deriver';
import { deriveActivityEffort } from './effort';
import { StrategyRegistry } from './registry';
import {
  DEFAULT_CLASSIFIER_ID,
  EF_QUADRANT_V1,
  classifyAll,
  createClassifierRegistry,
  efQuadrantClassifier,
} from './trend-classifier';

const b = (z: number | null): BaselineResult => ({
  asOf: '2026-10-04',
  shortMean: 1,
  shortCount: 7,
  longMean: 1,
  longStdDev: z === null ? 0 : 1,
  longCount: 28,
  z,
});

describe('StrategyRegistry', () => {
  const s = (id: string) => ({ id, description: id });

  it('keeps registration order and looks up by id', () => {
    const r = new StrategyRegistry('thing', [s('b_v1'), s('a_v1')]);
    expect(r.list().map((x) => x.id)).toEqual(['b_v1', 'a_v1']);
    expect(r.get('a_v1')?.id).toBe('a_v1');
    expect(r.get('nope')).toBeUndefined();
    expect(() => r.require('nope')).toThrow(/unknown thing "nope"/);
  });

  it('rejects duplicate and malformed ids (ids are persisted)', () => {
    const r = new StrategyRegistry('thing', [s('a_v1')]);
    expect(() => r.register(s('a_v1'))).toThrow(/already registered/);
    for (const bad of ['', 'Peak20', '1abc', 'has-dash', 'x'.repeat(64)]) {
      expect(() => r.register(s(bad)), bad).toThrow(/must match/);
    }
  });
});

describe('activity-effort derivers (PLAN §8.8)', () => {
  it('peak20_v1 is the default and is exactly deriveActivityEffort', () => {
    expect(DEFAULT_DERIVER_ID).toBe('peak20_v1');
    expect(createDeriverRegistry().list()).toEqual([PEAK20_V1]);
    const stream = Array.from({ length: 1500 }, (_, t) => ({ t, watts: 200 + (t % 5), hr: 150 }));
    expect(PEAK20_V1.derive(stream, { minDurationSec: 60 })).toEqual(
      deriveActivityEffort(stream, { minDurationSec: 60 }),
    );
  });

  it('each call returns a fresh registry, so tests and callers cannot leak variants', () => {
    const r = createDeriverRegistry();
    r.register({ id: 'alt_v1', description: 'x', derive: PEAK20_V1.derive });
    expect(createDeriverRegistry().get('alt_v1')).toBeUndefined();
  });
});

describe('trend classifiers (PLAN §8.7)', () => {
  it('ef_quadrant_v1 is the default and matches the §8.3 classifier with default config', () => {
    expect(DEFAULT_CLASSIFIER_ID).toBe('ef_quadrant_v1');
    const inputs = { ef: b(1.2), hrv: b(-1), restingHr: b(1) };
    expect(EF_QUADRANT_V1.classify(inputs)).toEqual(
      classifyFatigueFitness(inputs.ef, recoveryTrend(inputs.hrv, inputs.restingHr)),
    );
    expect(EF_QUADRANT_V1.classify(inputs).state).toBe('overreaching_risk');
  });

  it('a tuned variant applies its own config to both EF and recovery', () => {
    const tight = efQuadrantClassifier('ef_quadrant_tight_v1', 'dead zone 0.2', {
      efDeadZone: 0.2,
      recoveryDeadZone: 0.2,
    });
    const inputs = { ef: b(0.3), hrv: b(0.3), restingHr: b(-0.3) };
    expect(EF_QUADRANT_V1.classify(inputs).state).toBe('steady');
    expect(tight.classify(inputs).state).toBe('fitness_gain');
    expect(DEFAULT_CLASSIFIER_CONFIG.efDeadZone).toBe(0.5);
  });

  it('rejects an invalid config when the variant is defined, not at classify time', () => {
    expect(() => efQuadrantClassifier('bad_v1', 'x', { efMinLongPoints: 1 })).toThrow();
  });

  it('classifyAll runs every registered classifier on the same inputs, in order', () => {
    const r = createClassifierRegistry().register(
      efQuadrantClassifier('ef_quadrant_tight_v1', 'tight', { efDeadZone: 0.2 }),
    );
    const out = classifyAll(r, { ef: b(0.3), hrv: b(0), restingHr: b(0) });
    expect(out.map((o) => [o.classifierId, o.classification.state])).toEqual([
      ['ef_quadrant_v1', 'steady'],
      ['ef_quadrant_tight_v1', 'fitness_gain'],
    ]);
  });
});
