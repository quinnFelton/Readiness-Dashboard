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
      res.json({ users: await new UserService(getPool()).list() });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
