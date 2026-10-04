import { format } from 'node:util';
import { randomBytes } from 'node:crypto';
import {
  type CallbackContext,
  type FetchContext,
  type FetchResult,
  createAdapterRegistry,
} from '@rd/provider-adapters';
import type { NormalizedDailyMetric } from '@rd/shared-types';
import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { signApiToken } from '../auth/token';
import { signOAuthState } from '../crypto/oauth-state';
import { LocalAesGcmCipher } from '../crypto/token-cipher';
import { FakeAdapter } from '../sync/fake-adapter';
import { SyncService } from '../sync/sync-service';
import { closePool, getPool } from '../users/pool';
import { connectionsRouter } from './routes';

// CLAUDE.md rule 6: tokens never reach logs or API responses. Every console method and raw
// stdout/stderr write is captured while the token-bearing paths run (connect, list, sync,
// disconnect), including failure paths where the adapter's error message embeds the token.
// Needs migrated local Postgres (docker compose up -d db && pnpm db:migrate). No network.
process.env.NEXTAUTH_SECRET = 'test-secret-test-secret-test-secret';

const ACCESS = `acc-${randomBytes(12).toString('hex')}`;
const REFRESH = `ref-${randomBytes(12).toString('hex')}`;
const SECRETS = [ACCESS, REFRESH];

/** Fake adapter with unguessable tokens that can be told to fail with the token in the error. */
class LeakyAdapter extends FakeAdapter<NormalizedDailyMetric> {
  failCallback = false;
  failFetch = false;
  seenAccessToken: string | undefined;

  override async handleCallback(ctx: CallbackContext) {
    if (this.failCallback) throw new Error(`provider rejected token ${ACCESS} / ${REFRESH}`);
    return { ...(await super.handleCallback(ctx)), accessToken: ACCESS, refreshToken: REFRESH };
  }

  override async fetchRaw(ctx: FetchContext): Promise<FetchResult> {
    this.seenAccessToken = ctx.accessToken;
    if (this.failFetch)
      throw new Error(`401 for Bearer ${ctx.accessToken} refresh=${ctx.refreshToken}`);
    return super.fetchRaw(ctx);
  }
}

describe('tokens stay out of logs and responses (CLAUDE.md rule 6)', () => {
  const oura = new LeakyAdapter('oura', 'daily_metrics_source');
  const registry = createAdapterRegistry();
  registry.register(oura);
  const cipher = new LocalAesGcmCipher(randomBytes(32).toString('base64'));
  const stateSecret = randomBytes(32);
  const nowSec = () => Math.floor(Date.now() / 1000);
  const sync = new SyncService(getPool(), registry, cipher);

  const app = express();
  app.use(express.json());
  app.use('/connections', connectionsRouter({ pool: getPool(), registry, cipher, stateSecret }));

  let userId: string;
  let auth: string;
  let output: string[];

  const callback = () =>
    request(app)
      .get('/connections/oura/callback')
      .query({
        code: 'c1',
        state: signOAuthState({ userId, provider: 'oura', nowSec: nowSec() }, stateSecret),
      })
      .set('Authorization', auth);

  const expectNoSecrets = (label: string, text: string) => {
    for (const s of SECRETS) expect(text, `${label} leaked a token`).not.toContain(s);
  };

  beforeAll(async () => {
    const { rows } = await getPool().query<{ id: string }>(
      'INSERT INTO users(email) VALUES ($1) RETURNING id',
      [`tokenlog-${randomBytes(4).toString('hex')}@phase2.invalid`],
    );
    userId = rows[0]!.id;
    auth = `Bearer ${signApiToken({ userId, role: 'user' }, { nowSec: nowSec() })}`;
  });

  beforeEach(() => {
    output = [];
    // util.format renders args the way console does, so Error messages and nested objects count.
    const capture = (...args: unknown[]) => {
      output.push(format(...args));
    };
    for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
      vi.spyOn(console, m).mockImplementation(capture);
    }
    for (const stream of [process.stdout, process.stderr]) {
      const real = stream.write.bind(stream);
      vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: never[]) => {
        output.push(String(chunk));
        return real(chunk as string, ...rest);
      }) as typeof stream.write);
    }
    oura.failCallback = false;
    oura.failFetch = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    expectNoSecrets('console/stdout/stderr', output.join('\n'));
  });

  afterAll(async () => {
    await getPool().query('DELETE FROM users WHERE id=$1', [userId]);
    await closePool();
  });

  it('connect + list: responses never carry tokens; DB holds ciphertext only', async () => {
    const res = await callback();
    expect(res.status).toBe(200);
    expectNoSecrets('callback response', res.text);
    expect(res.text).not.toMatch(/token_enc|accessToken|refreshToken/);

    const cfg = await request(app).get('/connections/config').set('Authorization', auth);
    expect(cfg.status).toBe(200);
    expectNoSecrets('GET /config response', cfg.text);
    expect(cfg.text).not.toMatch(/token_enc|accessToken|refreshToken/);

    const { rows } = await getPool().query(
      'SELECT access_token_enc, refresh_token_enc FROM provider_connections WHERE user_id=$1',
      [userId],
    );
    const stored = Buffer.concat([rows[0].access_token_enc, rows[0].refresh_token_enc]);
    expectNoSecrets('stored token columns', stored.toString('latin1'));
  });

  it('adapter callback failure embedding the token → generic 500, nothing logged', async () => {
    oura.failCallback = true;
    const res = await callback();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal error' });
    expectNoSecrets('failed callback response', res.text);
  });

  it('sync success and failure: decrypted token reaches only the adapter', async () => {
    await callback();
    oura.enqueue([]);
    const ok = await sync.syncUser(userId);
    expect(oura.seenAccessToken).toBe(ACCESS);
    expectNoSecrets('sync result', JSON.stringify(ok));

    oura.failFetch = true;
    const failed = await sync.syncUser(userId);
    expect(failed.find((r) => r.provider === 'oura')).toMatchObject({ ok: false });
    expectNoSecrets('failed sync result', JSON.stringify(failed));
  });

  it('disconnect: no tokens in response or logs', async () => {
    await callback();
    const res = await request(app).delete('/connections/oura').set('Authorization', auth);
    expect(res.status).toBe(204);
    expectNoSecrets('disconnect response', res.text);
  });
});
