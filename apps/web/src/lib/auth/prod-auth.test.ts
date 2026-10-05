import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDENTITY_TOLERANCE_SEC, verifyIdentityRequest } from '../../../../api/src/auth/identity';
import { resolveUserByEmail, signIdentityRequest } from './identity';
import { loadRuntimeSecrets, regionOfArn, resetRuntimeSecretsForTests } from './runtime-secrets';

// Phase 9: production sign-in (security review H3) and runtime secrets (stage E item).
// No network, no AWS: fetch and the Secrets Manager client are stubs.

const SECRET = 'web-test-secret-0123456789abcdef0123456789';
const NOW = 1_800_000_000;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  resetRuntimeSecretsForTests();
});

describe('identity request signature (web signs, API verifies)', () => {
  it('a request signed by the web side verifies in the API', async () => {
    const sig = await signIdentityRequest('a@example.com', NOW, SECRET);
    const ok = verifyIdentityRequest(
      { email: 'a@example.com', ts: String(NOW), sig },
      { secret: SECRET, nowSec: NOW + 5 },
    );
    expect(ok).toBe(true);
  });

  it('rejects another email, another secret, a stale or future timestamp, and junk', async () => {
    const sig = await signIdentityRequest('a@example.com', NOW, SECRET);
    const check = (
      o: Partial<{ email: string; ts: string; sig: string; secret: string; now: number }>,
    ) =>
      verifyIdentityRequest(
        { email: o.email ?? 'a@example.com', ts: o.ts ?? String(NOW), sig: o.sig ?? sig },
        { secret: o.secret ?? SECRET, nowSec: o.now ?? NOW },
      );
    expect(check({})).toBe(true);
    expect(check({ email: 'b@example.com' })).toBe(false);
    expect(check({ secret: 'another-secret-0123456789abcdef0123456789' })).toBe(false);
    expect(check({ now: NOW + IDENTITY_TOLERANCE_SEC + 1 })).toBe(false);
    expect(check({ now: NOW - IDENTITY_TOLERANCE_SEC - 1 })).toBe(false);
    expect(check({ ts: 'abc' })).toBe(false);
    expect(check({ sig: 'AAAA' })).toBe(false);
    expect(
      verifyIdentityRequest(
        { email: 'a@example.com', ts: String(NOW), sig: undefined },
        { secret: SECRET, nowSec: NOW },
      ),
    ).toBe(false);
  });

  it('the signing key is derived, not the raw NEXTAUTH_SECRET (L7)', async () => {
    const { createHmac } = await import('node:crypto');
    const rawSecretSig = createHmac('sha256', SECRET)
      .update(`rd-web-identity.v1.${NOW}.a@example.com`)
      .digest('base64url');
    expect(rawSecretSig).not.toBe(await signIdentityRequest('a@example.com', NOW, SECRET));
  });
});

describe('resolveUserByEmail', () => {
  const user = { id: 'u1', email: 'a@example.com', name: null, role: 'user' as const };
  const stub = (res: Response | Error) =>
    vi.fn(async () => {
      if (res instanceof Error) throw res;
      return res;
    });

  it('sends a signed POST and returns the user', async () => {
    const f = stub(new Response(JSON.stringify({ user }), { status: 200 }));
    const got = await resolveUserByEmail('a@example.com', {
      apiUrl: 'http://api.test',
      secret: SECRET,
      nowSec: NOW,
      fetch: f as never,
    });
    expect(got).toEqual(user);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api.test/api/v1/auth/oauth-identity');
    const h = init.headers as Record<string, string>;
    expect(h['x-rd-ts']).toBe(String(NOW));
    expect(h['x-rd-sig']).toBe(await signIdentityRequest('a@example.com', NOW, SECRET));
  });

  it('is null (sign-in refused) for an unknown email, an API error, or a network failure', async () => {
    for (const res of [
      new Response('{}', { status: 404 }),
      new Response('{}', { status: 401 }),
      new Response('{}', { status: 500 }),
      new Response('{}', { status: 200 }), // no user in the body
      new Error('ECONNREFUSED'),
    ]) {
      expect(
        await resolveUserByEmail('x@example.com', {
          apiUrl: 'http://api.test',
          secret: SECRET,
          fetch: stub(res) as never,
        }),
      ).toBeNull();
    }
  });
});

describe('NextAuth config: providers and callbacks', () => {
  const load = async (env: Record<string, string>) => {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    return (await import('./config')).authConfig;
  };
  const ids = (c: { providers: unknown[] }) =>
    c.providers.map((p) =>
      typeof p === 'function' ? (p as () => { id: string })().id : (p as { id: string }).id,
    );

  it('locally: dev credentials AND google; in a deployed stage (STAGE set): google only', async () => {
    expect(ids(await load({ STAGE: '' }))).toEqual(['credentials', 'google']);
    expect(ids(await load({ STAGE: 'prod' }))).toEqual(['google']);
    expect(ids(await load({ STAGE: 'dev' }))).toEqual(['google']);
  });

  it('google sign-in is refused for unverified emails and for emails with no users row', async () => {
    const cfg = await load({ NEXTAUTH_SECRET: SECRET, API_URL: 'http://api.test' });
    const signIn = cfg.callbacks.signIn as unknown as (a: unknown) => Promise<boolean>;
    const fetchStub = vi.fn(async () => new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', fetchStub);
    expect(
      await signIn({
        account: { provider: 'google' },
        profile: { email: 'x@example.com', email_verified: false },
      }),
    ).toBe(false);
    expect(fetchStub).not.toHaveBeenCalled(); // unverified: not even asked
    expect(
      await signIn({
        account: { provider: 'google' },
        profile: { email: 'x@example.com', email_verified: true },
      }),
    ).toBe(false);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('google sign-in succeeds for an existing user, and the jwt takes uid/role from the API, not from Google', async () => {
    const cfg = await load({ NEXTAUTH_SECRET: SECRET, API_URL: 'http://api.test' });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              user: { id: 'u9', email: 'm@example.com', name: null, role: 'master' },
            }),
            { status: 200 },
          ),
      ),
    );
    const profile = {
      email: 'm@example.com',
      email_verified: true,
      role: 'user',
      sub: 'google-sub',
    };
    const signIn = cfg.callbacks.signIn as unknown as (a: unknown) => Promise<boolean>;
    expect(await signIn({ account: { provider: 'google' }, profile })).toBe(true);
    const jwt = cfg.callbacks.jwt as unknown as (a: unknown) => Promise<Record<string, unknown>>;
    expect(
      await jwt({
        token: {},
        user: { id: 'google-sub' },
        account: { provider: 'google' },
        profile,
      }),
    ).toMatchObject({ uid: 'u9', role: 'master' });
    vi.unstubAllGlobals();
  });

  it('the jwt callback fails closed (no session) when the email has no users row', async () => {
    const cfg = await load({ NEXTAUTH_SECRET: SECRET });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 404 })),
    );
    const jwt = cfg.callbacks.jwt as unknown as (a: unknown) => Promise<unknown>;
    await expect(
      jwt({
        token: {},
        account: { provider: 'google' },
        profile: { email: 'x@example.com', email_verified: true },
      }),
    ).rejects.toThrow();
    vi.unstubAllGlobals();
  });
});

describe('runtime secrets (no secret in build artifacts)', () => {
  const arn = 'arn:aws:secretsmanager:us-west-2:123456789012:secret:rd/dev/nextauth-AbCdEf';
  const client = (byArn: Record<string, unknown>) => ({
    send: vi.fn(async (cmd: { input: { SecretId: string } }) => ({
      SecretString: JSON.stringify(byArn[cmd.input.SecretId]),
    })),
  });

  it('does nothing (and loads no AWS SDK) when RUNTIME_SECRET_ARNS is unset: local dev, tests, e2e', async () => {
    const env: NodeJS.ProcessEnv = {};
    await loadRuntimeSecrets(env, client({}));
    expect(env).toEqual({});
  });

  it('copies allowed keys into env (NEXTAUTH_SECRET also becomes AUTH_SECRET), skipping placeholders and extras', async () => {
    const env: NodeJS.ProcessEnv = { RUNTIME_SECRET_ARNS: arn };
    const c = client({
      [arn]: {
        NEXTAUTH_SECRET: 's3cret-value',
        AUTH_GOOGLE_ID: 'REPLACE_ME',
        DATABASE_URL: 'postgres://nope',
        X: 1,
      },
    });
    await loadRuntimeSecrets(env, c);
    expect(env.NEXTAUTH_SECRET).toBe('s3cret-value');
    expect(env.AUTH_SECRET).toBe('s3cret-value');
    expect(env.AUTH_GOOGLE_ID).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined(); // only an allowlist of keys is ever taken
  });

  it('never overwrites a value already in the environment, and memoises per process', async () => {
    const env: NodeJS.ProcessEnv = { RUNTIME_SECRET_ARNS: arn, NEXTAUTH_SECRET: 'from-env' };
    const c = client({ [arn]: { NEXTAUTH_SECRET: 'from-secret' } });
    await loadRuntimeSecrets(env, c);
    await loadRuntimeSecrets(env, c);
    expect(env.NEXTAUTH_SECRET).toBe('from-env');
    expect(c.send).toHaveBeenCalledTimes(1);
  });

  it('a failed load is retried and never echoes secret material', async () => {
    const env: NodeJS.ProcessEnv = { RUNTIME_SECRET_ARNS: arn };
    const bad = { send: vi.fn(async () => ({ SecretString: 'not-json-hunter2' })) };
    const err = await loadRuntimeSecrets(env, bad).catch((e: Error) => e);
    expect(String(err)).not.toContain('hunter2');
    const good = client({ [arn]: { NEXTAUTH_SECRET: 'ok-value' } });
    await loadRuntimeSecrets(env, good);
    expect(env.NEXTAUTH_SECRET).toBe('ok-value');
  });

  it('takes the region from the ARN', () => {
    expect(regionOfArn(arn)).toBe('us-west-2');
    expect(regionOfArn('junk')).toBeUndefined();
  });
});
