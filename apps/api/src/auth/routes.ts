import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { getPool } from '../users/pool';
import { UserService } from '../users/service';

// PLAN §6: POST /auth/login — credential check used by the NextAuth Credentials provider.
// DEV ONLY: enabled when AUTH_DEV_PASSWORD is set and NODE_ENV !== 'production'. Swap for a
// magic-link provider in the web app without touching RBAC (the API only trusts tokens).

function safeEqual(a: string, b: string): boolean {
  // Hash first so lengths match and timingSafeEqual doesn't leak length.
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function authRouter(): Router {
  const r = Router();

  r.post('/login', async (req, res, next) => {
    try {
      const devPassword = process.env.AUTH_DEV_PASSWORD;
      if (!devPassword || process.env.NODE_ENV === 'production') {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const { email, password } = (req.body ?? {}) as { email?: unknown; password?: unknown };
      if (typeof email !== 'string' || typeof password !== 'string') {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      const user = await new UserService(getPool()).getByEmail(email);
      // Always compare, so unknown-email and bad-password take the same path.
      const passwordOk = safeEqual(password, devPassword);
      if (!user || !passwordOk) {
        res.status(401).json({ error: 'invalid_credentials' });
        return;
      }
      res.json({ user });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
