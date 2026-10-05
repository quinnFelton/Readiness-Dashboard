import { randomBytes } from 'node:crypto';
import { StravaAuthError } from '@rd/provider-adapters/strava';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StravaIngestService } from '../../providers/strava/strava-ingest-service';
import { closePool, getPool } from '../../users/pool';
import { kickStravaReplay } from '../../lambda/webhooks';
import { replayMaxAttempts, replayStravaEvents } from './routes';

// Phase 9: replayStravaEvents used to retry a permanently failing event until the 30-day TTL.
// Needs migrated local Postgres (webhook_events.attempts + the 'abandoned' status).

const pool = () => getPool();
const EVENT = { object_type: 'activity', object_id: 4, aspect_type: 'create', owner_id: 1 };

describe('replayStravaEvents retry cap', () => {
  let userId: string;
  let eventId: string;
  const ingestWith = (fn: () => Promise<unknown>) =>
    ({ ingestActivity: vi.fn(fn) }) as unknown as StravaIngestService & {
      ingestActivity: ReturnType<typeof vi.fn>;
    };
  const row = async () =>
    (
      await pool().query<{ status: string; attempts: number }>(
        `SELECT status, attempts FROM webhook_events WHERE id = $1`,
        [eventId],
      )
    ).rows[0]!;

  beforeAll(async () => {
    userId = (
      await pool().query<{ id: string }>(`INSERT INTO users(email) VALUES ($1) RETURNING id`, [
        `cap-${randomBytes(4).toString('hex')}@phase9.invalid`,
      ])
    ).rows[0]!.id;
  });
  beforeEach(async () => {
    await pool().query(`DELETE FROM webhook_events WHERE user_id = $1`, [userId]);
    eventId = (
      await pool().query<{ id: string }>(
        `INSERT INTO webhook_events (user_id, provider, payload_jsonb, status)
         VALUES ($1,'strava',$2,'failed') RETURNING id`,
        [userId, JSON.stringify(EVENT)],
      )
    ).rows[0]!.id;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterAll(async () => {
    await pool().query('DELETE FROM users WHERE id = $1', [userId]);
    await closePool();
  });

  it('retries a transient failure up to the cap, then goes terminal and is never selected again', async () => {
    const ingest = ingestWith(async () => {
      throw new Error('network');
    });
    const opts = { maxAttempts: 3 };
    await replayStravaEvents(pool(), ingest, opts);
    expect(await row()).toEqual({ status: 'failed', attempts: 1 });
    await replayStravaEvents(pool(), ingest, opts);
    expect(await row()).toEqual({ status: 'failed', attempts: 2 });
    await replayStravaEvents(pool(), ingest, opts);
    expect(await row()).toEqual({ status: 'abandoned', attempts: 3 });

    ingest.ingestActivity.mockClear();
    await replayStravaEvents(pool(), ingest, opts);
    expect(ingest.ingestActivity).not.toHaveBeenCalled();
    expect(await row()).toEqual({ status: 'abandoned', attempts: 3 });
  });

  it('a revoked grant (auth error) is terminal immediately: reconnecting is the only fix', async () => {
    const ingest = ingestWith(async () => {
      throw new StravaAuthError();
    });
    await replayStravaEvents(pool(), ingest, { maxAttempts: 5 });
    expect(await row()).toEqual({ status: 'abandoned', attempts: 1 });
  });

  it('an unparseable stored payload is terminal immediately', async () => {
    await pool().query(`UPDATE webhook_events SET payload_jsonb = '{"x":1}' WHERE id = $1`, [
      eventId,
    ]);
    const ingest = ingestWith(async () => undefined);
    await replayStravaEvents(pool(), ingest, { maxAttempts: 5 });
    expect(ingest.ingestActivity).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({ status: 'abandoned' });
  });

  it('a later success still marks processed (and keeps the attempt count)', async () => {
    await pool().query(`UPDATE webhook_events SET attempts = 2 WHERE id = $1`, [eventId]);
    await replayStravaEvents(
      pool(),
      ingestWith(async () => undefined),
      { maxAttempts: 3 },
    );
    expect(await row()).toEqual({ status: 'processed', attempts: 2 });
  });

  it('the cap is config (STRAVA_REPLAY_MAX_ATTEMPTS), default 5, junk falls back', () => {
    expect(replayMaxAttempts({})).toBe(5);
    expect(replayMaxAttempts({ STRAVA_REPLAY_MAX_ATTEMPTS: '2' })).toBe(2);
    expect(replayMaxAttempts({ STRAVA_REPLAY_MAX_ATTEMPTS: '0' })).toBe(5);
    expect(replayMaxAttempts({ STRAVA_REPLAY_MAX_ATTEMPTS: 'x' })).toBe(5);
  });
});

describe('kickStravaReplay with the router hint (security review M4)', () => {
  const post = { rawPath: '/api/v1/webhooks/strava', requestContext: { http: { method: 'POST' } } };
  const env = { STRAVA_REPLAY_FUNCTION: 'rd-dev-strava-replay' } as NodeJS.ProcessEnv;

  it('kicks only when the router flagged a pending event', async () => {
    const send = vi.fn(async () => ({}));
    expect(await kickStravaReplay(post, 200, env, { send }, {})).toBe(false);
    expect(await kickStravaReplay(post, 200, env, { send }, { 'x-rd-replay': '0' })).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(await kickStravaReplay(post, 200, env, { send }, { 'x-rd-replay': '1' })).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
