import type { User } from '@rd/shared-types';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { verifyApiToken } from '../auth/token';
import { getPool } from '../users/pool';
import { UserService } from '../users/service';

// PLAN §2 / §12, CLAUDE.md rule 3: RBAC is enforced here, server-side, on every route.

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireUser. Role comes from the DB, never from the token. */
      user?: User;
    }
  }
}

function bearer(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const [scheme, token, ...rest] = h.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length > 0) return null;
  return token;
}

/** 401 unless a valid web-minted token maps to an existing user. */
export const requireUser: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = bearer(req);
    const claims = token ? verifyApiToken(token, { nowSec: Math.floor(Date.now() / 1000) }) : null;
    if (!claims) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    // Re-read from DB so role changes / deleted users take effect immediately.
    const user = await new UserService(getPool()).getById(claims.sub);
    if (!user) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
};

/** Must run after requireUser. 403 unless role is master. */
export const requireMaster: RequestHandler = (req, res, next) => {
  if (!req.user) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  if (req.user.role !== 'master') {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  next();
};

/**
 * Must run after requireUser. Master passes for any target; a `user` passes only when
 * `req.params[paramName]` is their own id. A missing param is denied (fail closed).
 */
export function requireSelfOrMaster(paramName: string): RequestHandler {
  return (req, res, next) => {
    if (!req.user) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const target = req.params[paramName];
    if (req.user.role === 'master' || (typeof target === 'string' && target === req.user.id)) {
      next();
      return;
    }
    res.status(403).json({ error: 'forbidden' });
  };
}
