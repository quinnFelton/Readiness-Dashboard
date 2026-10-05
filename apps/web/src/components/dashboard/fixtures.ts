// Typed mock fixtures for the PLAN §6 / phases/5b.md contract. Used by tests, and by the API
// client when DASHBOARD_MOCK=1 so the UI can be developed before phase 5b's routes are merged.
import type {
  AthleteEvent,
  FeedbackResponse,
  ScoresResponse,
  TrendRow,
  TrendsResponse,
} from '@rd/shared-types';

const CLASSIFIER = 'ef_quadrant_v1';

function day(n: number): string {
  return new Date(Date.UTC(2026, 8, 1 + n)).toISOString().slice(0, 10); // 2026-09-01 + n
}

function stateRow(asOf: string, state: string, text: string): TrendRow {
  return {
    metricType: 'fatigue_fitness_state',
    window: '28d',
    classifierId: CLASSIFIER,
    asOf,
    zScore: null,
    direction: state,
    insightText: text,
    flaggedAt: `${asOf}T07:00:00Z`,
  };
}

export const FIXTURE_TRENDS: TrendsResponse = {
  classifierId: CLASSIFIER,
  trends: [
    stateRow(day(10), 'steady', 'Efficiency steady: steady fitness and fatigue.'),
    stateRow(day(16), 'fitness_gain', 'Efficiency rising with recovery stable: fitness gain.'),
    stateRow(
      day(22),
      'overreaching_risk',
      'Efficiency rising while recovery falling: overreaching risk.',
    ),
    stateRow(
      day(26),
      'overreaching_risk',
      'Efficiency rising while recovery falling: overreaching risk.',
    ),
    ...(['hrv', 'resting_hr', 'ef_peak20', 'ef_overall'] as const).flatMap((metricType) =>
      (['7d', '28d'] as const).map<TrendRow>((window) => ({
        metricType,
        window,
        classifierId: CLASSIFIER,
        asOf: day(26),
        zScore: window === '7d' ? -1.2 : -0.3,
        direction: window === '7d' ? 'down' : 'flat',
        insightText: null,
        flaggedAt: `${day(26)}T07:00:00Z`,
      })),
    ),
  ],
  series: {
    // EF only on ride days: sparse by design.
    efPeak20: [0, 2, 5, 9, 12, 16, 19, 23, 26].map((n, i) => ({
      date: day(n),
      value: 1.7 + i * 0.02,
    })),
    efOverall: [0, 2, 5, 9, 12, 16, 19, 23, 26].map((n, i) => ({
      date: day(n),
      value: 1.5 + i * 0.01,
    })),
    hrv: Array.from({ length: 27 }, (_, n) => ({ date: day(n), value: 70 - n * 0.4 })),
    restingHr: Array.from({ length: 27 }, (_, n) => ({ date: day(n), value: 50 + n * 0.1 })),
  },
};

export const FIXTURE_SCORES: ScoresResponse = {
  scores: Array.from({ length: 27 }, (_, n) => ({
    date: day(n),
    score: 80 - n * 0.6,
    components: { recovery: 80 - n * 0.6 },
  })),
};

export const FIXTURE_FEEDBACK: FeedbackResponse = { feedback: [] };

export const FIXTURE_EVENTS: AthleteEvent[] = [
  { id: 'evt-1', date: day(20), eventType: 'illness', notes: 'head cold' },
];

export const EMPTY_TRENDS: TrendsResponse = {
  classifierId: CLASSIFIER,
  trends: [],
  series: { efPeak20: [], efOverall: [], hrv: [], restingHr: [] },
};
