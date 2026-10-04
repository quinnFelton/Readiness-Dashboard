/// <reference types="node" />
import { describe, expect, it, vi } from 'vitest';
import { OuraAdapter, OuraHttpError, OuraRateLimitError } from './adapter';
import { type OuraConfig, ouraConfigFromEnv } from './config';
import { OuraSubscriptions } from './subscriptions';
import {
  answerVerification,
  ouraSignature,
  parseOuraWebhookEvent,
  verifyOuraSignature,
} from './webhook';

const NOW = new Date('2026-09-10T12:00:00Z');
const TS = String(Math.floor(NOW.getTime() / 1000));
const SECRET = 'client-secret';
const BODY = JSON.stringify({
  event_type: 'update',
  data_type: 'sleep',
  object_id: '12345abc',
  event_time: '2026-09-10T11:59:30+00:00',
  user_id: 'user123',
});
const verify = (over: Partial<Parameters<typeof verifyOuraSignature>[0]> = {}) =>
  verifyOuraSignature({
    clientSecret: SECRET,
    signature: ouraSignature(SECRET, TS, BODY),
    timestamp: TS,
    rawBody: BODY,
    now: NOW,
    toleranceSec: 300,
    ...over,
  });

describe('verifyOuraSignature', () => {
  it('accepts a correct uppercase-hex HMAC(timestamp + body)', () => {
    const sig = ouraSignature(SECRET, TS, BODY);
    expect(sig).toMatch(/^[0-9A-F]{64}$/);
    expect(verify().ok).toBe(true);
  });
  it('is case-insensitive on the received signature', () => {
    expect(verify({ signature: ouraSignature(SECRET, TS, BODY).toLowerCase() }).ok).toBe(true);
  });
  it('accepts a signature over the canonical JSON.stringify of the body (docs reference impl)', () => {
    const spaced = `{ "event_type": "update", "data_type": "sleep", "object_id": "1", "user_id": "u" }`;
    const canonical = JSON.stringify(JSON.parse(spaced));
    expect(verify({ rawBody: spaced, signature: ouraSignature(SECRET, TS, canonical) }).ok).toBe(
      true,
    );
  });
  it('rejects a tampered body, wrong secret, wrong timestamp', () => {
    expect(verify({ rawBody: BODY.replace('sleep', 'tag') })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(verify({ clientSecret: 'other' }).reason).toBe('bad_signature');
    expect(verify({ timestamp: String(Number(TS) + 1) }).reason).toBe('bad_signature');
  });
  it('rejects missing headers and an unconfigured secret', () => {
    expect(verify({ signature: undefined }).reason).toBe('missing_header');
    expect(verify({ timestamp: undefined }).reason).toBe('missing_header');
    expect(verify({ clientSecret: '' }).ok).toBe(false);
  });
  it('rejects non-hex / wrong-length signatures without throwing', () => {
    expect(verify({ signature: 'abc' }).ok).toBe(false);
    expect(verify({ signature: 'Z'.repeat(64) }).ok).toBe(false);
  });
  it('enforces the freshness window (signed but stale = replay)', () => {
    const old = String(Math.floor(NOW.getTime() / 1000) - 301);
    expect(verify({ timestamp: old, signature: ouraSignature(SECRET, old, BODY) }).reason).toBe(
      'stale_timestamp',
    );
    const edge = String(Math.floor(NOW.getTime() / 1000) - 300);
    expect(verify({ timestamp: edge, signature: ouraSignature(SECRET, edge, BODY) }).ok).toBe(true);
    const future = String(Math.floor(NOW.getTime() / 1000) + 3600);
    expect(
      verify({ timestamp: future, signature: ouraSignature(SECRET, future, BODY) }).reason,
    ).toBe('stale_timestamp');
  });
  it('accepts a millisecond timestamp', () => {
    const ms = String(NOW.getTime());
    expect(verify({ timestamp: ms, signature: ouraSignature(SECRET, ms, BODY) }).ok).toBe(true);
  });
});

describe('parseOuraWebhookEvent / answerVerification', () => {
  it('parses the documented body fields', () => {
    expect(parseOuraWebhookEvent(JSON.parse(BODY))).toEqual({
      eventType: 'update',
      dataType: 'sleep',
      objectId: '12345abc',
      eventTime: '2026-09-10T11:59:30+00:00',
      ouraUserId: 'user123',
    });
  });
  it('returns null for malformed bodies', () => {
    expect(parseOuraWebhookEvent(null)).toBeNull();
    expect(parseOuraWebhookEvent([])).toBeNull();
    expect(parseOuraWebhookEvent({ event_type: 'update' })).toBeNull();
  });
  it('echoes the challenge only for the right verification_token', () => {
    expect(answerVerification({ verification_token: 't', challenge: 'abc' }, 't')).toBe('abc');
    expect(answerVerification({ verification_token: 'x', challenge: 'abc' }, 't')).toBeNull();
    expect(answerVerification({ verification_token: 't' }, 't')).toBeNull();
    expect(answerVerification({ verification_token: '', challenge: 'abc' }, '')).toBeNull();
  });
});

describe('OuraSubscriptions', () => {
  const sub = (id: string, event: string, data: string, exp: string) => ({
    id,
    callback_url: 'https://api.test/api/v1/webhooks/oura',
    event_type: event,
    data_type: data,
    expiration_time: exp,
  });
  function setup(existing: unknown[], over: Partial<OuraConfig> = {}) {
    const calls: { method: string; url: string; headers: Record<string, string>; body?: string }[] =
      [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({
        method,
        url: String(url),
        headers: init?.headers as Record<string, string>,
        body: init?.body as string | undefined,
      });
      if (method === 'GET') return new Response(JSON.stringify(existing), { status: 200 });
      if (method === 'DELETE') return new Response(null, { status: 204 });
      return new Response(JSON.stringify(sub('new', 'create', 'sleep', '2027-01-01T00:00:00Z')), {
        status: method === 'POST' ? 201 : 200,
      });
    });
    const cfg: OuraConfig = {
      ...ouraConfigFromEnv({}),
      clientId: 'cid',
      clientSecret: 'csec',
      webhookCallbackUrl: 'https://api.test/api/v1/webhooks/oura',
      webhookVerificationToken: 'vtok',
      webhookCollections: { daily_readiness: 'daily_readiness', sleep: 'sleep' },
      webhookEventTypes: ['create', 'delete'],
      subscriptionRenewWithinSec: 7 * 86400,
      now: () => NOW,
      fetch: fetchMock as unknown as typeof fetch,
      ...over,
    };
    return { subs: new OuraSubscriptions(cfg), calls };
  }

  it('authenticates with x-client-id / x-client-secret (no bearer token)', async () => {
    const { subs, calls } = setup([]);
    await subs.list();
    const c = calls[0]!;
    expect(c.url).toBe('https://api.ouraring.com/v2/webhook/subscription');
    expect(c.headers['x-client-id']).toBe('cid');
    expect(c.headers['x-client-secret']).toBe('csec');
    expect(c.headers.authorization).toBeUndefined();
  });

  it('create posts the spec body shape', async () => {
    const { subs, calls } = setup([]);
    await subs.create({
      callbackUrl: 'https://x/y',
      verificationToken: 'v',
      eventType: 'create',
      dataType: 'sleep',
    });
    expect(calls[0]?.method).toBe('POST');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      callback_url: 'https://x/y',
      verification_token: 'v',
      event_type: 'create',
      data_type: 'sleep',
    });
  });

  it('ensure creates missing, renews expiring, leaves healthy ones, and is idempotent', async () => {
    const far = '2026-12-01T00:00:00Z';
    const soon = '2026-09-12T00:00:00Z';
    const { subs, calls } = setup([
      sub('a', 'create', 'sleep', far),
      sub('b', 'delete', 'sleep', soon),
    ]);
    const r = await subs.ensure();
    expect(r.created.sort()).toEqual(['create:daily_readiness', 'delete:daily_readiness']);
    expect(r.renewed).toEqual(['delete:sleep']);
    expect(r.unchanged).toEqual(['create:sleep']);
    const renew = calls.find((c) => c.method === 'PUT');
    expect(renew?.url).toBe('https://api.ouraring.com/v2/webhook/subscription/renew/b');

    // a fully-subscribed account triggers no writes
    const all = setup(
      ['daily_readiness', 'sleep'].flatMap((d) =>
        ['create', 'delete'].map((e) => sub(`${e}${d}`, e, d, far)),
      ),
    );
    const r2 = await all.subs.ensure();
    expect(r2.created).toEqual([]);
    expect(all.calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('ignores subscriptions that point at another callback URL', async () => {
    const other = {
      ...sub('z', 'create', 'sleep', '2030-01-01T00:00:00Z'),
      callback_url: 'https://other',
    };
    const { subs } = setup([other], {
      webhookEventTypes: ['create'],
      webhookCollections: { sleep: 'sleep' },
    });
    expect((await subs.ensure()).created).toEqual(['create:sleep']);
  });

  it('refuses to run without a callback URL / verification token', async () => {
    const { subs } = setup([], { webhookCallbackUrl: '' });
    await expect(subs.ensure()).rejects.toThrow(/not configured/);
  });

  it('maps 429 / errors without leaking bodies', async () => {
    const mk = (res: Response) =>
      new OuraSubscriptions({
        ...ouraConfigFromEnv({}),
        fetch: (async () => res) as unknown as typeof fetch,
      });
    await expect(
      mk(new Response('secret-body', { status: 429, headers: { 'retry-after': '12' } })).list(),
    ).rejects.toMatchObject({ retryAfterSec: 12 });
    await expect(mk(new Response('secret-body', { status: 429 })).list()).rejects.toBeInstanceOf(
      OuraRateLimitError,
    );
    const err = await mk(new Response('secret-body', { status: 401 }))
      .list()
      .catch((e) => e);
    expect(err).toBeInstanceOf(OuraHttpError);
    expect(String(err.message)).not.toContain('secret-body');
  });
});

describe('OuraAdapter.fetchWindow', () => {
  it('fetches only the requested collections over the explicit window', async () => {
    const urls: string[] = [];
    const adapter = new OuraAdapter({
      ...ouraConfigFromEnv({}),
      now: () => NOW,
      fetch: (async (u: string | URL | Request) => {
        urls.push(String(u));
        return new Response(
          JSON.stringify({ data: [{ day: '2026-09-09', score: 80 }], next_token: null }),
        );
      }) as unknown as typeof fetch,
    });
    const r = await adapter.fetchWindow(
      { userId: 'u', accessToken: 'tok', expiresAt: new Date('2026-09-11T00:00:00Z'), since: null },
      { startDate: '2026-09-07', endDate: '2026-09-11' },
      ['daily_readiness'],
    );
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(
      '/v2/usercollection/daily_readiness?start_date=2026-09-07&end_date=2026-09-11',
    );
    expect(r.raw).toMatchObject({ dailySleep: [], sleep: [] });
    expect((r.raw as { dailyReadiness: unknown[] }).dailyReadiness).toHaveLength(1);
  });
});
