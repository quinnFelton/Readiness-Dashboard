import express, { type Express, type RequestHandler } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app';
import {
  GUARD,
  type GuardInfo,
  requireMaster,
  requireSelfOrMaster,
  requireUser,
} from './middleware/rbac';

// CLAUDE.md rule 3 / phase 9: enumerate the REAL Express router and fail on any route that has no
// server-side authorization, so a new endpoint cannot ship unguarded by accident.
//
// Express 5's router does not keep mount paths as strings, so we record them while the app is being
// built by wrapping Router.prototype.use. Everything else is read from the live layer stack.

interface Layer {
  handle: RequestHandler & { stack?: Layer[] };
  route?: { path: string; methods: Record<string, boolean>; stack: Layer[] };
  mountPath?: string;
}
type Proto = { use: (this: { stack: Layer[] }, ...args: unknown[]) => unknown };

/** The object in the prototype chain that actually owns `use` (the router package's prototype). */
function ownerOfUse(): Proto {
  let o: object | null = express.Router();
  while (o && !Object.prototype.hasOwnProperty.call(o, 'use')) o = Object.getPrototypeOf(o);
  if (!o) throw new Error('could not find Router.prototype.use');
  return o as Proto;
}
const proto = ownerOfUse();
const originalUse = proto.use;

beforeAll(() => {
  proto.use = function (this: { stack: Layer[] }, ...args: unknown[]) {
    const before = this.stack.length;
    const out = originalUse.apply(this, args);
    const first = args[0];
    const mount =
      typeof first === 'string'
        ? first
        : Array.isArray(first) && typeof first[0] === 'string'
          ? first[0]
          : '/';
    for (let i = before; i < this.stack.length; i++) this.stack[i]!.mountPath = mount;
    return out;
  };
});
afterAll(() => {
  proto.use = originalUse;
});

interface Found {
  key: string; // "GET /api/v1/users/:userId/export"
  path: string;
  chain: RequestHandler[];
}

const join = (a: string, b: string) => `${a}/${b}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');

function walk(stack: Layer[], prefix: string, inherited: RequestHandler[], out: Found[]): void {
  const local = [...inherited]; // router-level middleware registered BEFORE a route applies to it
  for (const layer of stack) {
    const mount = layer.mountPath ?? '/';
    if (layer.route) {
      const path = join(prefix, layer.route.path);
      for (const method of Object.keys(layer.route.methods)) {
        out.push({
          key: `${method.toUpperCase()} ${path}`,
          path,
          chain: [...local, ...layer.route.stack.map((l) => l.handle)],
        });
      }
    } else if (layer.handle.stack) {
      walk(layer.handle.stack, join(prefix, mount), local, out);
    } else if (mount === '/') {
      local.push(layer.handle);
    } else if (layer.handle.length !== 4) {
      // path-scoped plain middleware can answer requests too: treat it like a route
      const path = join(prefix, mount);
      out.push({ key: `USE ${path}`, path, chain: [...local, layer.handle] });
    }
  }
}

function enumerate(app: Express): Found[] {
  const out: Found[] = [];
  walk((app as unknown as { router: { stack: Layer[] } }).router.stack, '/', [], out);
  return out;
}

const guardsOf = (f: Found): GuardInfo[] =>
  f.chain
    .map((h) => (h as unknown as Record<symbol, GuardInfo | undefined>)[GUARD])
    .filter((g): g is GuardInfo => !!g);

// Routes that are unauthenticated BY DESIGN, with the reason. Everything else needs requireUser.
const PUBLIC_ROUTES: Record<string, string> = {
  'GET /api/v1/health': 'liveness probe, no data',
  'POST /api/v1/auth/login':
    'dev credentials login; 404 in production (apps/api/src/auth/routes.ts)',
};
// Provider webhooks authenticate by signature / verify token, not a user session (PLAN §5, §6).
// Each has its own tests (webhooks/**, providers/oura/webhook.test.ts).
const WEBHOOK_PREFIX = '/api/v1/webhooks/';

/** Returns a description of every route that lacks the required authorization. */
export function findUnguarded(found: Found[]): string[] {
  const problems: string[] = [];
  for (const f of found) {
    if (f.key in PUBLIC_ROUTES || f.path.startsWith(WEBHOOK_PREFIX)) continue;
    const guards = guardsOf(f);
    if (!guards.some((g) => g.kind === 'user')) {
      problems.push(`${f.key}: no requireUser`);
      continue;
    }
    // Any path parameter that names a person must be bound to self-or-master / master.
    for (const [, param] of f.path.matchAll(/:(\w+)/g)) {
      if (!/user|athlete/i.test(param!)) continue;
      const bound = guards.some(
        (g) => g.kind === 'master' || (g.kind === 'self-or-master' && g.param === param),
      );
      if (!bound)
        problems.push(`${f.key}: :${param} is not bound by requireSelfOrMaster/requireMaster`);
    }
  }
  return problems;
}

describe('every route has an authorization check', () => {
  it('the real app: no unguarded route outside the explicit allowlist', () => {
    const found = enumerate(createApp());
    // The walker must actually see the app, or an empty list would pass vacuously.
    expect(found.length).toBeGreaterThan(25);
    expect(found.map((f) => f.key)).toEqual(
      expect.arrayContaining([
        'GET /api/v1/users/me',
        'GET /api/v1/users/:userId/export',
        'DELETE /api/v1/users/:userId',
        'DELETE /api/v1/connections/:provider',
      ]),
    );
    expect(findUnguarded(found)).toEqual([]);
  });

  it('the allowlist has no stale entries, and webhooks are the only other public routes', () => {
    const found = enumerate(createApp());
    const keys = new Set(found.map((f) => f.key));
    for (const k of Object.keys(PUBLIC_ROUTES))
      expect(keys.has(k), `stale allowlist: ${k}`).toBe(true);
    const hooks = found.filter((f) => f.path.startsWith(WEBHOOK_PREFIX));
    // Adding a webhook route must be a deliberate edit here.
    expect(hooks.map((f) => f.key).sort()).toEqual([
      'GET /api/v1/webhooks/oura',
      'GET /api/v1/webhooks/strava',
      'POST /api/v1/webhooks/oura',
      'POST /api/v1/webhooks/strava',
      'POST /api/v1/webhooks/terra',
    ]);
    const unguardedNonHooks = found.filter(
      (f) => !f.path.startsWith(WEBHOOK_PREFIX) && !guardsOf(f).some((g) => g.kind === 'user'),
    );
    expect(unguardedNonHooks.map((f) => f.key).sort()).toEqual(Object.keys(PUBLIC_ROUTES).sort());
  });

  it('master-only surfaces keep requireMaster', () => {
    const found = enumerate(createApp());
    const ours = (k: string) => found.find((f) => f.key === k)!;
    expect(guardsOf(ours('GET /api/v1/users')).some((g) => g.kind === 'master')).toBe(true);
    for (const f of found.filter((x) => x.path.startsWith('/api/v1/comparison'))) {
      expect(
        guardsOf(f).some((g) => g.kind === 'master'),
        f.key,
      ).toBe(true);
    }
  });

  it('detects the mistakes it exists to catch (checker self-test)', () => {
    const app = express();
    const r = express.Router();
    r.get('/open', (_req, res) => void res.json({})); // no guard at all
    r.get('/:userId/data', requireUser, (_req, res) => void res.json({})); // authenticated, not bound
    r.get(
      '/:userId/ok',
      requireUser,
      requireSelfOrMaster('userId'),
      (_req, res) => void res.json({}),
    );
    r.get(
      '/:athleteId/wrong',
      requireUser,
      requireSelfOrMaster('userId'),
      (_req, res) => void res.json({}),
    );
    r.get('/admin', requireUser, requireMaster, (_req, res) => void res.json({}));
    app.use('/api/v1/t', r);
    app.use('/api/v1/mw', (_req, res) => void res.json({})); // path-scoped middleware that answers
    const problems = findUnguarded(enumerate(app));
    expect(problems).toEqual([
      'GET /api/v1/t/open: no requireUser',
      'GET /api/v1/t/:userId/data: :userId is not bound by requireSelfOrMaster/requireMaster',
      'GET /api/v1/t/:athleteId/wrong: :athleteId is not bound by requireSelfOrMaster/requireMaster',
      'USE /api/v1/mw: no requireUser',
    ]);
  });
});
