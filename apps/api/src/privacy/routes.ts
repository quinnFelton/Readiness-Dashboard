import { type AdapterRegistry, defaultRegistry } from '@rd/provider-adapters';
import { type ErrorRequestHandler, Router } from 'express';
import type pg from 'pg';
import { HttpError } from '../connections/errors';
import { type TokenCipher, createTokenCipher } from '../crypto/token-cipher';
import { requireSelfOrMaster, requireUser } from '../middleware/rbac';
import { getPool } from '../users/pool';
import { LastMasterError, deleteUserCompletely } from './delete-service';
import { exportUserData } from './export-service';

// PLAN §12 "build per-user data export/delete from the start".
//   GET    /users/:userId/export   JSON of everything stored about the user (self or master)
//   DELETE /users/:userId?confirm=true   revoke provider grants + delete every row (self or master)
// Authorization is server-side, in the middleware chain on each route (CLAUDE.md rule 3). Mounted
// next to usersRouter at /users; `/users/me` and `/users` are handled there first.

export interface PrivacyDeps {
  pool?: pg.Pool;
  registry?: AdapterRegistry;
  cipher?: TokenCipher;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function privacyRouter(deps: PrivacyDeps = {}): Router {
  const pool = () => deps.pool ?? getPool();
  const registry = deps.registry ?? defaultRegistry;
  let cipher = deps.cipher;
  const getCipher = () => (cipher ??= createTokenCipher());

  const r = Router();
  const guard = [requireUser, requireSelfOrMaster('userId')];

  const targetId = (raw: string | string[] | undefined): string => {
    const id = Array.isArray(raw) ? raw[0] : raw;
    if (!id || !UUID_RE.test(id)) throw new HttpError(404, 'user not found');
    return id;
  };

  r.get('/:userId/export', ...guard, async (req, res) => {
    const userId = targetId(req.params.userId);
    const data = await exportUserData(pool(), userId);
    if (!data) throw new HttpError(404, 'user not found');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `attachment; filename="rd-export-${userId}.json"`);
    res.json(data);
  });

  r.delete('/:userId', ...guard, async (req, res) => {
    const userId = targetId(req.params.userId);
    if (req.query.confirm !== 'true') {
      throw new HttpError(400, 'deleting an account is irreversible: pass ?confirm=true');
    }
    const result = await deleteUserCompletely(
      { pool: pool(), registry, cipher: getCipher() },
      userId,
    );
    if (!result.deleted) throw new HttpError(404, 'user not found');
    // Audit line: ids and provider names only, no email/name/health data (rule 6).
    console.info(
      JSON.stringify({
        event: 'user_deleted',
        userId,
        actor: req.user!.id === userId ? 'self' : 'master',
        revoked: result.revoked,
      }),
    );
    res.json({ deleted: true, revoked: result.revoked });
  });

  const onError: ErrorRequestHandler = (err, _req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (err instanceof LastMasterError) {
      res.status(409).json({ error: err.message });
      return;
    }
    // Never echo or log err details: they may carry row values (rule 6).
    res.status(500).json({ error: 'internal error' });
  };
  r.use(onError);
  return r;
}
