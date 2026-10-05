import { Router } from 'express';
import { requireMaster, requireUser } from '../middleware/rbac';
import { getPool } from './pool';
import { UserService } from './service';

// PLAN §6: GET /users/me (any authenticated user), GET /users (master only).
export function usersRouter(): Router {
  const r = Router();

  r.get('/me', requireUser, (req, res) => {
    res.json({ user: req.user });
  });

  r.get('/', requireUser, requireMaster, async (_req, res, next) => {
    try {
      const pool = getPool();
      const users = await new UserService(pool).list();
      // Roster enrichment (PLAN §10 flow 6): which sources each athlete has connected and when
      // they last synced. Token columns are never selected.
      const { rows } = await pool.query<{
        user_id: string;
        provider: string;
        role: 'activity_source' | 'daily_metrics_source';
        last_synced_at: Date | null;
      }>(
        `SELECT user_id, provider, role, last_synced_at
           FROM provider_connections WHERE is_active ORDER BY provider`,
      );
      // Latest fatigue/fitness state per athlete in ONE query (PLAN §13: DISTINCT ON against
      // `trends` is cheap at this scale). The admin roster used to call /trends/:id once per user.
      // Same meaning as that route: the DEFAULT classifier's state rows from the last 28 days.
      const latest = await pool.query<{ user_id: string; state: string | null; as_of: string }>(
        `SELECT DISTINCT ON (t.user_id)
                t.user_id, t.direction AS state, to_char(t.as_of, 'YYYY-MM-DD') AS as_of
           FROM trends t
          WHERE t.metric_type = 'fatigue_fitness_state' AND t.trend_window = '7d'
            AND t.classifier_id = (SELECT id FROM classifiers WHERE is_default)
            AND t.as_of > (now() AT TIME ZONE 'utc')::date - 28
          ORDER BY t.user_id, t.as_of DESC, t.flagged_at DESC`,
      );
      const latestByUser = new Map(latest.rows.map((r) => [r.user_id, r]));
      res.json({
        users: users.map((u) => {
          const connections = rows
            .filter((r) => r.user_id === u.id)
            .map((r) => ({
              provider: r.provider,
              role: r.role,
              lastSyncAt: r.last_synced_at?.toISOString() ?? null,
            }));
          const lastSyncAt =
            connections
              .map((c) => c.lastSyncAt)
              .filter((x): x is string => !!x)
              .sort()
              .at(-1) ?? null;
          const state = latestByUser.get(u.id);
          return {
            ...u,
            connections,
            lastSyncAt,
            // null (not absent) = "no state yet", so the web roster does not fall back to N requests.
            latestState: state?.state ?? null,
            latestStateAsOf: state?.as_of ?? null,
          };
        }),
      });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
