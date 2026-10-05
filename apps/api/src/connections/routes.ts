import { type AdapterRegistry, defaultRegistry } from '@rd/provider-adapters';
import { type ErrorRequestHandler, Router } from 'express';
import type pg from 'pg';
import { oauthStateSecretFromEnv, signOAuthState, verifyOAuthState } from '../crypto/oauth-state';
import { type TokenCipher, createTokenCipher } from '../crypto/token-cipher';
import { requireUser } from '../middleware/rbac';
import { getPool } from '../users/pool';
import { ConnectionConfigService } from './config-service';
import { ConnectionService } from './connection-service';
import { HttpError } from './errors';

export interface ConnectionsDeps {
  pool?: pg.Pool;
  registry?: AdapterRegistry;
  cipher?: TokenCipher;
  /** Secret for signing OAuth state (>= 32 bytes); defaults to oauthStateSecretFromEnv(). */
  stateSecret?: Buffer;
  nowSec?: () => number;
}

const PROVIDER_RE = /^[a-z0-9_-]{1,32}$/;
const RESERVED = new Set(['config', 'providers']);

// PLAN §6 REST surface. Authorization: every route is behind requireUser and operates only on
// req.user.id — there is no :userId parameter, so a `user` can never address another user's data.
// (Master gets no cross-user access here; that is deliberate for token-bearing resources.)
export function connectionsRouter(deps: ConnectionsDeps = {}): Router {
  const pool = deps.pool ?? getPool();
  const registry = deps.registry ?? defaultRegistry;
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  let cipher = deps.cipher;
  const getCipher = () => (cipher ??= createTokenCipher());
  const stateSecret = () => deps.stateSecret ?? oauthStateSecretFromEnv();

  const configs = new ConnectionConfigService(pool, registry);
  const connections = () => new ConnectionService(pool, registry, getCipher(), configs);

  const r = Router();
  r.use(requireUser);

  const providerParam = (raw: string | string[] | undefined): string => {
    const p = Array.isArray(raw) ? raw[0] : raw;
    if (!p || !PROVIDER_RE.test(p) || RESERVED.has(p)) throw new HttpError(404, 'unknown provider');
    return p;
  };

  // Registered adapters for the connections screen, so the UI never hardcodes the list (PLAN §6).
  // Registry metadata only: no per-user data, but still behind requireUser like every route here.
  r.get('/providers', (_req, res) => {
    const roles = ['activity_source', 'daily_metrics_source'] as const;
    const providers = roles.flatMap((role) =>
      registry.listByRole(role).map((a) => ({
        key: a.key,
        role: a.role,
        displayName: a.displayName ?? a.key,
        flow: a.connectFlow ?? 'oauth',
      })),
    );
    res.json({ providers });
  });

  r.get('/config', async (req, res) => {
    const userId = req.user!.id;
    const [config, precedence, list] = await Promise.all([
      configs.getConfig(userId),
      configs.getPrecedence(userId),
      connections().list(userId),
    ]);
    res.json({ config, precedence, connections: list });
  });

  r.put('/config', async (req, res) => {
    const userId = req.user!.id;
    const body = (req.body ?? {}) as { activitySource?: unknown; dailyMetricsSources?: unknown };
    const { activitySource, dailyMetricsSources } = body;
    const validAct =
      activitySource === undefined || activitySource === null || typeof activitySource === 'string';
    const validDaily =
      dailyMetricsSources === undefined ||
      (Array.isArray(dailyMetricsSources) &&
        dailyMetricsSources.every((s) => typeof s === 'string'));
    if (
      !validAct ||
      !validDaily ||
      (activitySource === undefined && dailyMetricsSources === undefined)
    ) {
      throw new HttpError(
        400,
        'expected activitySource (string|null) and/or dailyMetricsSources (string[])',
      );
    }
    // Settings item: a provider can only be NEWLY selected while it is actively connected for this
    // user (the UI disables the control, but the UI is never the control: CLAUDE.md rule 3).
    // Providers already in the saved config stay allowed, so reordering precedence or deselecting a
    // source whose token has since expired still works.
    const [list, current] = await Promise.all([
      connections().list(userId),
      configs.getConfig(userId),
    ]);
    const connected = new Set(list.filter((c) => c.isActive).map((c) => c.provider));
    const kept = new Set([current.activitySource, ...current.dailyMetricsSources]);
    const wanted = [
      ...(typeof activitySource === 'string' ? [activitySource] : []),
      ...((dailyMetricsSources as string[] | undefined) ?? []),
    ];
    if (wanted.some((p) => !connected.has(p) && !kept.has(p))) {
      throw new HttpError(400, 'connect a provider before selecting it');
    }
    if (activitySource !== undefined) await configs.setActivitySource(userId, activitySource);
    if (dailyMetricsSources !== undefined) {
      await configs.setDailyMetricsSources(userId, dailyMetricsSources as string[]);
    }
    res.json({
      config: await configs.getConfig(userId),
      precedence: await configs.getPrecedence(userId),
    });
  });

  r.post('/:provider/start', async (req, res) => {
    const provider = providerParam(req.params.provider);
    const adapter = registry.getByProvider(provider);
    if (!adapter) throw new HttpError(404, 'unknown provider');
    const userId = req.user!.id;
    const state = signOAuthState({ userId, provider, nowSec: nowSec() }, stateSecret());
    const { redirectUrl } = await adapter.start({ userId, state });
    res.json({ redirectUrl });
  });

  r.get('/:provider/callback', async (req, res) => {
    const provider = providerParam(req.params.provider);
    const userId = req.user!.id;
    const query: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.query)) if (typeof v === 'string') query[k] = v;
    if (!verifyOAuthState(query.state, { userId, provider, nowSec: nowSec() }, stateSecret())) {
      throw new HttpError(400, 'invalid or expired state');
    }
    const connection = await connections().completeCallback(userId, provider, query);
    res.json({ connection });
  });

  r.delete('/:provider', async (req, res) => {
    const provider = providerParam(req.params.provider);
    // History is kept unless the caller asks for the erase explicitly (PLAN §10 flow 8, §12).
    const deleteData = req.query.deleteData === 'true';
    await connections().disconnect(req.user!.id, provider, { deleteData });
    res.status(204).end();
  });

  const onError: ErrorRequestHandler = (err, _req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    // Never echo or log err details here: they may carry provider payload fragments (rule 6).
    res.status(500).json({ error: 'internal error' });
  };
  r.use(onError);

  return r;
}
