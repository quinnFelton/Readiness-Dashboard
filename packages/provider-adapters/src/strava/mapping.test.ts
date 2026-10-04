import { describe, expect, it } from 'vitest';
import { rideSummary, steadyStreams } from './__fixtures__/strava';
import { createStravaAdapter } from './adapter';
import { StravaClient, StravaAuthError } from './client';
import {
  DEFAULT_STRAVA_FILTER,
  activityDate,
  skipReason,
  streamsToSamples,
  trainingLoad,
} from './mapping';

describe('skipReason (pre-fetch gate)', () => {
  it('passes a 30-min ride', () => expect(skipReason(rideSummary())).toBeNull());
  it.each(['Run', 'Swim', 'EBikeRide', 'Walk'])('skips non-ride type %s', (t) =>
    expect(skipReason(rideSummary({ sport_type: t, type: t }))).toBe('not_ride'),
  );
  it('accepts VirtualRide and falls back to legacy `type`', () => {
    expect(skipReason(rideSummary({ sport_type: 'VirtualRide' }))).toBeNull();
    expect(skipReason(rideSummary({ sport_type: undefined, type: 'Ride' }))).toBeNull();
  });
  it('skips activities under the configured minimum', () => {
    expect(skipReason(rideSummary({ moving_time: 1199 }))).toBe('too_short');
    expect(
      skipReason(rideSummary({ moving_time: 1199 }), {
        ...DEFAULT_STRAVA_FILTER,
        minDurationSec: 600,
      }),
    ).toBeNull();
  });
  it('skips manual and HR-less activities', () => {
    expect(skipReason(rideSummary({ manual: true }))).toBe('manual');
    expect(skipReason(rideSummary({ has_heartrate: false }))).toBe('no_heartrate');
  });
});

describe('mapping helpers', () => {
  it('uses the local start date', () => {
    expect(
      activityDate(
        rideSummary({
          start_date_local: '2026-03-01T23:30:00Z',
          start_date: '2026-03-02T04:30:00Z',
        }),
      ),
    ).toBe('2026-03-01');
    expect(activityDate({ id: 1 })).toBeNull();
  });
  it('zips parallel stream arrays, tolerating missing series', () => {
    const s = steadyStreams(3);
    expect(streamsToSamples(s)).toEqual([
      { t: 0, watts: 200, hr: 140 },
      { t: 1, watts: 200, hr: 140 },
      { t: 2, watts: 200, hr: 140 },
    ]);
    expect(streamsToSamples({ time: { data: [0, 1] } })).toEqual([
      { t: 0, watts: null, hr: null },
      { t: 1, watts: null, hr: null },
    ]);
  });
});

describe('trainingLoad (hand-checkable)', () => {
  it('TSS: 1 h at FTP = 100', () => {
    const r = trainingLoad(
      { durationSec: 3600, avgHr: 150, normalizedPower: 250 },
      { ftp: 250, hrMax: 190, hrRest: 60 },
    );
    expect(r?.method).toBe('tss');
    expect(r?.value).toBeCloseTo(100, 6);
  });
  it('TSS: 30 min at 80% FTP = 32', () => {
    const r = trainingLoad(
      { durationSec: 1800, avgHr: 150, normalizedPower: 200 },
      { ftp: 250, hrMax: 190, hrRest: 60 },
    );
    expect(r?.value).toBeCloseTo(0.5 * 0.64 * 100, 6);
  });
  it('TRIMP fallback without FTP: 60 min at HRR 0.5', () => {
    // avgHr 125 → HRR (125-60)/(190-60) = 0.5 → 60 × 0.5 × 0.64 × e^0.96
    const r = trainingLoad(
      { durationSec: 3600, avgHr: 125, normalizedPower: 180 },
      { ftp: null, hrMax: 190, hrRest: 60 },
    );
    expect(r?.method).toBe('trimp');
    expect(r?.value).toBeCloseTo(60 * 0.5 * 0.64 * Math.exp(0.96), 6);
  });
  it('clamps HRR to [0,1] and returns null for invalid config', () => {
    expect(trainingLoad({ durationSec: 60, avgHr: 50, normalizedPower: null })?.value).toBe(0);
    expect(
      trainingLoad(
        { durationSec: 60, avgHr: 150, normalizedPower: null },
        { hrMax: 60, hrRest: 60 },
      ),
    ).toBeNull();
    expect(trainingLoad({ durationSec: 0, avgHr: 150, normalizedPower: null })).toBeNull();
  });
});

describe('strava adapter', () => {
  const client = new StravaClient({
    clientId: '1',
    clientSecret: 's',
    redirectUri: 'http://x/cb',
    fetch: (async () =>
      new Response(
        JSON.stringify({
          access_token: 'a',
          refresh_token: 'r',
          expires_at: 1900000000,
          athlete: { id: 7 },
        }),
      )) as never,
  });
  const adapter = createStravaAdapter({ client });

  it('is an activity_source keyed "strava" with no pull fetch (webhook-driven)', () => {
    expect(adapter.role).toBe('activity_source');
    expect(adapter.key).toBe('strava');
    expect(adapter.fetchRaw).toBeUndefined();
  });

  it('normalize derives scalars via the scoring engine', () => {
    const [row] = adapter.normalize({ activity: rideSummary(), streams: steadyStreams() });
    expect(row).toMatchObject({
      externalActivityId: '9001',
      date: '2026-03-01',
      source: 'strava',
      durationSec: 1800,
      avgHr: 140,
      peak20Power: 200,
      peak20AvgHr: 140,
    });
    expect(row?.normalizedPower).toBeCloseTo(200, 6);
  });

  it('normalize returns [] for skipped or too-short input', () => {
    expect(
      adapter.normalize({ activity: rideSummary({ sport_type: 'Run' }), streams: steadyStreams() }),
    ).toEqual([]);
    expect(adapter.normalize({ activity: rideSummary(), streams: steadyStreams(600) })).toEqual([]);
    expect(adapter.normalize(null)).toEqual([]);
  });

  it('callback rejects denial and missing scope; exchanges the code otherwise', async () => {
    await expect(
      adapter.handleCallback({ userId: 'u', query: { error: 'access_denied' } }),
    ).rejects.toBeInstanceOf(StravaAuthError);
    await expect(
      adapter.handleCallback({ userId: 'u', query: { code: 'c', scope: 'read' } }),
    ).rejects.toBeInstanceOf(StravaAuthError);
    const g = await adapter.handleCallback({
      userId: 'u',
      query: { code: 'c', scope: 'read,activity:read_all' },
    });
    expect(g.externalUserId).toBe('7');
    expect(g.refreshToken).toBe('r');
  });

  it('start returns the authorize URL carrying the state', async () => {
    const { redirectUrl } = await adapter.start({ userId: 'u', state: 'st' });
    expect(new URL(redirectUrl).searchParams.get('state')).toBe('st');
  });
});
