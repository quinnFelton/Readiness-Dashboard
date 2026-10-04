import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { closePool, getPool } from '../../users/pool';
import { handler as subscriptionsHandler } from './subscriptions-job';
import { handler as syncHandler } from './sync-job';
import { acquireOuraTestMutex } from './test-mutex';

// Lambda entrypoints build their deps from env; these tests run them that way.
// Sync needs migrated local Postgres; all Oura HTTP is mocked (CLAUDE.md rule 10).
const ENV = {
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  OURA_CLIENT_ID: 'client-id',
  OURA_CLIENT_SECRET: `client-secret-${randomBytes(6).toString('hex')}`,
  OURA_WEBHOOK_VERIFICATION_TOKEN: `verify-${randomBytes(6).toString('hex')}`,
  OURA_WEBHOOK_CALLBACK_URL: 'https://example.invalid/api/v1/webhooks/oura',
  OURA_WEBHOOK_DATA_TYPES: 'daily_sleep',
  OURA_WEBHOOK_EVENT_TYPES: 'create',
};

describe('Oura Lambda entrypoints', () => {
  // The empty-event sync handler touches EVERY active Oura connection, so hold the shared Oura test
  // mutex like the other Oura DB test files (otherwise it locks/syncs their users mid-test).
  let releaseMutex: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
    releaseMutex = await acquireOuraTestMutex(getPool());
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    vi.unstubAllEnvs();
    await releaseMutex?.();
    await closePool();
  });

  it('sync handler with a userId that has no Oura connection returns NotConnected, no network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const userId = randomUUID();
    const out = await syncHandler({ userId });
    expect(out.results[userId]).toMatchObject({ ok: false, error: 'NotConnected' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sync handler with an empty event syncs all users and returns a plain results object', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"data":[]}', { status: 200 })),
    );
    const out = await syncHandler();
    expect(out.results).toBeTypeOf('object');
    expect(JSON.stringify(out)).not.toContain(ENV.OURA_CLIENT_SECRET);
  });

  it('subscriptions handler creates a missing subscription with client headers, returns no secrets', async () => {
    const calls: { method: string; url: string; headers: Headers; body?: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init: RequestInit = {}) => {
        const method = init.method ?? 'GET';
        calls.push({
          method,
          url: String(url),
          headers: new Headers(init.headers),
          body: init.body as string | undefined,
        });
        if (method === 'GET') return new Response('[]', { status: 200 });
        return new Response(
          JSON.stringify({
            id: 'sub-1',
            callback_url: ENV.OURA_WEBHOOK_CALLBACK_URL,
            event_type: 'create',
            data_type: 'daily_sleep',
            expiration_time: '2030-01-01T00:00:00Z',
          }),
          { status: 201 },
        );
      }),
    );
    const out = await subscriptionsHandler();

    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('https://api.ouraring.com/v2/webhook/subscription');
    expect(post?.headers.get('x-client-id')).toBe(ENV.OURA_CLIENT_ID);
    expect(post?.headers.get('x-client-secret')).toBe(ENV.OURA_CLIENT_SECRET);
    expect(JSON.parse(post?.body ?? '{}')).toMatchObject({
      callback_url: ENV.OURA_WEBHOOK_CALLBACK_URL,
      verification_token: ENV.OURA_WEBHOOK_VERIFICATION_TOKEN,
      event_type: 'create',
      data_type: 'daily_sleep',
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain(ENV.OURA_CLIENT_SECRET);
    expect(text).not.toContain(ENV.OURA_WEBHOOK_VERIFICATION_TOKEN);
  });
});
