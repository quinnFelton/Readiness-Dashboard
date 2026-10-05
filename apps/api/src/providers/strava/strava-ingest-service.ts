import {
  STRAVA_PROVIDER_KEY,
  StravaAuthError,
  type StravaClient,
  tokenNeedsRefresh,
} from '@rd/provider-adapters/strava';
import type pg from 'pg';
import type { TokenCipher } from '../../crypto/token-cipher';
import type { ActivityEffortService, EffortOutcome } from '../../efforts/activity-effort-service';
import { type Recompute, sharedRecompute } from '../../fatigue-fitness/recompute';

export type IngestOutcome = EffortOutcome | { status: 'deleted' };

export interface StravaIngestDeps {
  pool: pg.Pool;
  cipher: TokenCipher;
  client: StravaClient;
  efforts: ActivityEffortService;
  now?: () => Date;
  /** Refresh when the access token expires within this many seconds (PLAN §5.2). Default 900. */
  refreshSkewSec?: number;
  /** Trend recompute after an activity lands or is removed (PLAN §8.4). Default: process-wide hook. */
  recompute?: Recompute;
}

interface TokenRow {
  access_token_enc: Buffer | null;
  refresh_token_enc: Buffer | null;
  expires_at: Date | null;
  is_active: boolean;
}

/**
 * Fetches exactly one activity (+ streams only if it passes the pre-filter) for a connected user
 * and hands it to ActivityEffortService. Strava has no webhook signature, so every event is only a
 * hint: this pulls from Strava with the user's own token and acts on what Strava says, never on the
 * event (a forged event costs one re-fetch; `delete` and deauthorization are confirmed first, H2).
 */
export class StravaIngestService {
  private readonly now: () => Date;
  private readonly skew: number;

  constructor(private readonly d: StravaIngestDeps) {
    this.now = d.now ?? (() => new Date());
    this.skew = d.refreshSkewSec ?? 900;
  }

  /** Maps Strava's athlete id (webhook `owner_id`) to a local user; null if not connected here. */
  async findUserByAthlete(athleteId: number | string): Promise<string | null> {
    const { rows } = await this.d.pool.query<{ user_id: string }>(
      `SELECT user_id FROM provider_connections
        WHERE provider = $1 AND external_user_id = $2 AND is_active`,
      [STRAVA_PROVIDER_KEY, String(athleteId)],
    );
    return rows[0]?.user_id ?? null;
  }

  /**
   * Returns a valid access token, refreshing first when near expiry. The row is locked
   * (FOR UPDATE) so concurrent webhook events do not each burn the refresh token; the loser
   * re-reads the winner's fresh token. Strava may rotate the refresh token on every refresh, so the
   * new one is always stored. Tokens are only ever persisted encrypted (CLAUDE.md rule 6).
   */
  async getAccessToken(userId: string): Promise<string> {
    const ctx = `${userId}:${STRAVA_PROVIDER_KEY}`;
    const db = await this.d.pool.connect();
    try {
      await db.query('BEGIN');
      const { rows } = await db.query<TokenRow>(
        `SELECT access_token_enc, refresh_token_enc, expires_at, is_active
           FROM provider_connections WHERE user_id = $1 AND provider = $2 FOR UPDATE`,
        [userId, STRAVA_PROVIDER_KEY],
      );
      const row = rows[0];
      if (!row || !row.is_active || !row.access_token_enc) {
        throw new StravaAuthError('strava connection inactive');
      }
      if (!tokenNeedsRefresh(row.expires_at, this.now(), this.skew)) {
        await db.query('COMMIT');
        return await this.d.cipher.decrypt(row.access_token_enc, ctx);
      }
      if (!row.refresh_token_enc) throw new StravaAuthError('no refresh token');
      let grant;
      try {
        grant = await this.d.client.refresh(
          await this.d.cipher.decrypt(row.refresh_token_enc, ctx),
        );
      } catch (err) {
        if (err instanceof StravaAuthError) {
          // Refresh token revoked/invalid: stop using this connection until the user reconnects.
          await db.query(
            `UPDATE provider_connections SET is_active = false
              WHERE user_id = $1 AND provider = $2`,
            [userId, STRAVA_PROVIDER_KEY],
          );
          await db.query('COMMIT');
        } else {
          await db.query('ROLLBACK');
        }
        throw err;
      }
      await db.query(
        `UPDATE provider_connections SET access_token_enc = $3, refresh_token_enc = $4, expires_at = $5
          WHERE user_id = $1 AND provider = $2`,
        [
          userId,
          STRAVA_PROVIDER_KEY,
          await this.d.cipher.encrypt(grant.accessToken as string, ctx),
          await this.d.cipher.encrypt(grant.refreshToken as string, ctx),
          grant.expiresAt ?? null,
        ],
      );
      await db.query('COMMIT');
      return grant.accessToken as string;
    } catch (err) {
      await db.query('ROLLBACK').catch(() => undefined); // no-op if already committed
      throw err;
    } finally {
      db.release();
    }
  }

  /** Webhook create/update: fetch only this activity, then derive → upsert (or remove). */
  async ingestActivity(userId: string, activityId: number | string): Promise<IngestOutcome> {
    const id = String(activityId);
    const token = await this.getAccessToken(userId);
    const activity = await this.d.client.getActivity(token, id);
    const before = await this.activityDates(userId, id);
    if (!activity) {
      await this.d.efforts.deleteActivity(userId, id); // gone since the event was sent
      await this.recompute(userId, before);
      return { status: 'deleted' };
    }
    // Selective stream fetch: only spend the streams call if the summary passes the filter.
    const streams = this.d.efforts.skipReasonFor(activity)
      ? {}
      : ((await this.d.client.getStreams(token, id)) ?? {});
    const outcome = await this.d.efforts.processActivity(userId, { activity, streams });
    await this.d.pool.query(
      `UPDATE provider_connections SET last_synced_at = $3 WHERE user_id = $1 AND provider = $2`,
      [userId, STRAVA_PROVIDER_KEY, this.now()],
    );
    // Old and new dates: an update can move the ride or remove it (now filtered out).
    await this.recompute(userId, [...before, ...(await this.activityDates(userId, id))]);
    return outcome;
  }

  /** Webhook `delete`. */
  async removeActivity(userId: string, activityId: number | string): Promise<number> {
    const id = String(activityId);
    const dates = await this.activityDates(userId, id);
    const removed = await this.d.efforts.deleteActivity(userId, id);
    if (removed > 0) await this.recompute(userId, dates);
    return removed;
  }

  /**
   * PLAN §8.4: compute on sync. The hook never throws, so a recompute failure can't fail the ingest
   * or flip the webhook event to `failed`.
   */
  private recompute(userId: string, dates: string[]): Promise<void> {
    return (this.d.recompute ?? sharedRecompute())(userId, 'activity', dates);
  }

  /** Days this activity currently has effort rows on (any deriver). */
  private async activityDates(userId: string, externalActivityId: string): Promise<string[]> {
    const { rows } = await this.d.pool.query<{ date: string }>(
      `SELECT DISTINCT to_char(date, 'YYYY-MM-DD') AS date FROM activity_efforts
        WHERE user_id = $1 AND external_activity_id = $2`,
      [userId, externalActivityId],
    );
    return rows.map((r) => r.date);
  }

  /**
   * A deauthorization event is only a hint (anyone can POST one: security review H2). Disconnect
   * only if Strava itself rejects the user's credentials: a refresh that fails with an auth error
   * (getAccessToken deactivates the row) or a 401 from GET /athlete. Returns whether it disconnected.
   * Transient errors (network, 5xx, rate limit) propagate so the event is retried, not trusted.
   */
  async confirmDeauthorized(userId: string): Promise<boolean> {
    try {
      const token = await this.getAccessToken(userId);
      await this.d.client.getAthlete(token);
      return false; // the grant still works: the event was stale or forged
    } catch (err) {
      if (err instanceof StravaAuthError) {
        await this.markDeauthorized(userId);
        return true;
      }
      throw err;
    }
  }

  /** Drops credentials and deactivates the connection. Call only after confirming (see above). */
  async markDeauthorized(userId: string): Promise<void> {
    await this.d.pool.query(
      `UPDATE provider_connections
          SET is_active = false, access_token_enc = NULL, refresh_token_enc = NULL
        WHERE user_id = $1 AND provider = $2`,
      [userId, STRAVA_PROVIDER_KEY],
    );
  }
}
