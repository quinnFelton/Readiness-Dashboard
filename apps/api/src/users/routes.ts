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
          return { ...u, connections, lastSyncAt };
        }),
      });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
