import { randomBytes } from 'node:crypto';
import { defaultRegistry } from '@rd/provider-adapters';
import type { NormalizedActivityEffort } from '@rd/shared-types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// Phase 6c's callback logic is pure (no Next imports), so the real web module drives this test.
import { type ApiFetch, completeOAuthCallback } from '../../../web/src/app/settings/_lib/callback';
import { createApp } from '../app';
import { signApiToken } from '../auth/token';
import { FakeAdapter } from '../sync/fake-adapter';
import { closePool, getPool } from '../users/pool';

// Integration stage D: OAuth state round-trip end to end.
//   web "Connect" → POST /api/v1/connections/<p>/start (signed state in the provider URL)
//   provider redirects the browser to /settings/connections/<p>/callback?code&state (6c page)
//   6c's completeOAuthCallback → GET /api/v1/connections/<p>/callback?code&state on the REAL app
// The provider is an in-memory FakeAdapter registered as 'strava' (no network, CLAUDE.md rule 10).
// Needs migrated local Postgres.
describe('OAuth state round-trip: 6c callback page → mounted /api/v1/connections/<provider>/callback', () => {
  const provider = 'strava';
  let userId: string;
  let otherId: string;
  const calls: string[] = [];

  const tokenFor = (id: string) =>
    signApiToken({ userId: id, role: 'user' }, { nowSec: Math.floor(Date.now() / 1000) });

  /** Same contract as apps/web/src/lib/auth/api-fetch.ts: prefixes /api/v1 and attaches a Bearer. */
  const apiFetchAs =
    (id: string): ApiFetch =>
    async (path, init = {}) => {
      calls.push(`${init.method ?? 'GET'} /api/v1${path}`);
      const app = createApp();
      const m = (init.method ?? 'GET').toLowerCase() as 'get' | 'post' | 'delete' | 'put';
      const res = await request(app)
        [m](`/api/v1${path}`)
        .set('authorization', `Bearer ${tokenFor(id)}`);
      return new Response(res.status === 204 ? null : JSON.stringify(res.body), {
        status: res.status,
        headers: { 'content-type': 'application/json' },
      });
    };

  /** What the web "Connect" button does (startConnection server action), then what the provider does. */
  async function startAndGetProviderRedirect(id: string) {
    const res = await apiFetchAs(id)(`/connections/${provider}/start`, { method: 'POST' });
    expect(res.status).toBe(200);
    const { redirectUrl } = (await res.json()) as { redirectUrl: string };
    const state = new URL(redirectUrl).searchParams.get('state');
    expect(state).toBeTruthy();
    return state as string;
  }

  beforeAll(async () => {
    vi.stubEnv('NEXTAUTH_SECRET', 'test-secret-test-secret-test-secret');
    vi.stubEnv('TOKEN_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    if (!defaultRegistry.getByProvider(provider)) {
      defaultRegistry.register(
        new FakeAdapter<NormalizedActivityEffort>(provider, 'activity_source'),
      );
    }
    const tag = randomBytes(4).toString('hex');
    const ins = async (who: string) =>
      (
        await getPool().query<{ id: string }>(`INSERT INTO users(email) VALUES ($1) RETURNING id`, [
          `${who}-${tag}@stage-d-oauth.invalid`,
        ])
      ).rows[0]!.id;
    userId = await ins('owner');
    otherId = await ins('other');
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await getPool().query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[userId, otherId]]);
    await closePool();
  });

  it('a valid state completes: the callback page hits the mounted API route and a connection is stored', async () => {
    const state = await startAndGetProviderRedirect(userId);
    calls.length = 0;

    // Query exactly as the provider appends it to the web callback URL.
    const outcome = await completeOAuthCallback(
      provider,
      { code: 'auth-code-123', state, scope: 'read,activity:read_all' },
      apiFetchAs(userId),
    );
    expect(outcome).toEqual({ status: 'success' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(
      new RegExp(`^GET /api/v1/connections/${provider}/callback\\?code=auth-code-123&state=`),
    );

    const { rows } = await getPool().query<{
      external_user_id: string;
      is_active: boolean;
      access_token_enc: Buffer;
    }>(
      `SELECT external_user_id, is_active, access_token_enc FROM provider_connections
        WHERE user_id = $1 AND provider = $2`,
      [userId, provider],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.external_user_id).toBe('ext-auth-code-123');
    expect(rows[0]!.is_active).toBe(true);
    // encrypted at rest (CLAUDE.md rule 6), never the plaintext token
    expect(rows[0]!.access_token_enc.toString('utf8')).not.toContain('fake-access-strava');
  });

  it('a state minted for another user is rejected (400 → "invalid or has expired"), nothing stored', async () => {
    const foreign = await startAndGetProviderRedirect(otherId);
    const outcome = await completeOAuthCallback(
      provider,
      { code: 'stolen', state: foreign },
      apiFetchAs(userId),
    );
    expect(outcome.status).toBe('error');
    expect(outcome).toMatchObject({ message: expect.stringMatching(/invalid or has expired/) });
    const { rows } = await getPool().query(
      `SELECT 1 FROM provider_connections WHERE user_id = $1`,
      [otherId],
    );
    expect(rows).toHaveLength(0);
  });

  it('a tampered state is rejected the same way', async () => {
    const state = await startAndGetProviderRedirect(userId);
    const outcome = await completeOAuthCallback(
      provider,
      { code: 'c', state: `${state.slice(0, -2)}xx` },
      apiFetchAs(userId),
    );
    expect(outcome).toMatchObject({
      status: 'error',
      message: expect.stringMatching(/invalid or has expired/),
    });
  });

  it('provider-reported denial never reaches the API', async () => {
    calls.length = 0;
    const outcome = await completeOAuthCallback(
      provider,
      { error: 'access_denied', state: 'whatever' },
      apiFetchAs(userId),
    );
    expect(outcome.status).toBe('denied');
    expect(calls).toHaveLength(0);
  });
});
