import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { createRateLimiter } from '../middleware/rate-limit';
import { getPool } from '../users/pool';
import { UserService } from '../users/service';
import { verifyIdentityRequest } from './identity';
import { getSigningSecret } from './token';

// PLAN §6: POST /auth/login — credential check used by the NextAuth Credentials provider.
// DEV ONLY: enabled when AUTH_DEV_PASSWORD is set and NODE_ENV !== 'production'. Production signs
// in through OAuth in the web app and uses /auth/oauth-identity below (security review H3).

function safeEqual(a: string, b: string): boolean {
  // Hash first so lengths match and timingSafeEqual doesn't leak length.
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function authRouter(): Router {
  const r = Router();

  // The dev login has one shared password, so it gets a per-client throttle (the review noted no
  // lockout at all). 10 attempts, then one more every 2 s. Not a control in AWS: the route is 404
  // there. Keyed on the socket address; behind a proxy that is the proxy, which only makes it
  // stricter.
  const loginThrottle = createRateLimiter({
    ratePerSec: 0.5,
    burst: 10,
    key: (req) => req.socket.remoteAddress ?? 'unknown',
  });

  r.post('/login', loginThrottle, async (req, res, next) => {
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

  // Called by the web server after Google has authenticated the person. Authenticated by an HMAC
  // only the web server can compute (./identity.ts), not by a user session: the caller has none yet.
  // Unknown email -> 404, so the web app refuses the sign-in (invite-only: no auto-provisioning).
  r.post('/oauth-identity', async (req, res, next) => {
    try {
      const { email } = (req.body ?? {}) as { email?: unknown };
      if (typeof email !== 'string' || email.length === 0 || email.length > 320) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      const ok = verifyIdentityRequest(
        { email, ts: req.get('x-rd-ts'), sig: req.get('x-rd-sig') },
        { secret: getSigningSecret(), nowSec: Math.floor(Date.now() / 1000) },
      );
      if (!ok) {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      const user = await new UserService(getPool()).getByEmail(email);
      if (!user) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ user });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
