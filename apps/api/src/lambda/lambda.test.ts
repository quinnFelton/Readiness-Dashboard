import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PLACEHOLDER,
  databaseUrlFromSecret,
  ensureBootstrapped,
  loadSecretsIntoEnv,
  resetBootstrapForTests,
} from './bootstrap';
import { resetPoolDefaults, sslFromEnv, toPgSsl } from '../users/pool';
import { iamDatabaseUrl } from './db-auth';
import { migrate } from './migrate';
import { runReplay } from './strava-replay';
import { DEFAULT_TTL_DAYS, deleteOldWebhookEvents, resolveDays } from './webhook-ttl';
import { createWebhooksApp, kickStravaReplay } from './webhooks';

// No AWS, no DB, no network (CLAUDE.md rule 10): Secrets Manager is a fake client, pg is a stub.

const secretsClient = (byArn: Record<string, unknown>) => ({
  send: vi.fn(async (cmd: { input: { SecretId?: string } }) => ({
    SecretString: JSON.stringify(byArn[cmd.input.SecretId ?? '']),
  })),
});

afterEach(() => {
  resetBootstrapForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('bootstrap (Secrets Manager -> env)', () => {
  it('builds DATABASE_URL from the DB secret, url-encoding the credentials, with NO sslmode (M3)', async () => {
    const env: NodeJS.ProcessEnv = { DB_SECRET_ARN: 'db', PG_SSL_CA_FILE: '/var/task/rds.pem' };
    await loadSecretsIntoEnv({
      env,
      client: secretsClient({
        db: {
          username: 'rd admin',
          password: 'p@ss/w:rd',
          host: 'h.example',
          port: 5432,
          dbname: 'readiness',
        },
      }),
    });
    // A connection-string sslmode would override the pool's verifying `ssl` option; never emit one.
    expect(env.DATABASE_URL).toBe('postgres://rd%20admin:p%40ss%2Fw%3Ard@h.example:5432/readiness');
    expect(env.DATABASE_URL).not.toMatch(/sslmode/);
  });

  it('fails closed without the RDS CA bundle: no unverified connection to Aurora (M3)', async () => {
    const client = secretsClient({ db: { username: 'u', password: 'p', host: 'h' } });
    await expect(loadSecretsIntoEnv({ env: { DB_SECRET_ARN: 'db' }, client })).rejects.toThrow(
      /PG_SSL_CA_FILE/,
    );
    await expect(
      loadSecretsIntoEnv({ env: { DB_IAM_USER: 'rd_api', DB_HOST: 'h', DB_NAME: 'readiness' } }),
    ).rejects.toThrow(/PG_SSL_CA_FILE/);
  });

  it('IAM auth: connects as the per-function db user with a signed token, reads no DB secret', async () => {
    const env: NodeJS.ProcessEnv = {
      DB_IAM_USER: 'rd_hook_strava',
      DB_HOST: 'cluster.example.rds.amazonaws.com',
      DB_NAME: 'readiness',
      PG_SSL_CA_FILE: '/var/task/rds.pem',
    };
    const getAuthToken = vi.fn(async () => 'signed-iam-token');
    const client = secretsClient({});
    await loadSecretsIntoEnv({ env, client, iamSigner: { getAuthToken } });
    // No password in the URL, and no Secrets Manager call at all (nothing to read).
    expect(env.DATABASE_URL).toBe(
      'postgres://rd_hook_strava@cluster.example.rds.amazonaws.com:5432/readiness',
    );
    expect(client.send).not.toHaveBeenCalled();
    expect(() => iamDatabaseUrl({ DB_IAM_USER: 'x' })).toThrow(/DB_HOST/);
    // The pool asks for a token per new connection.
    const { getPool, closePool } = await import('../users/pool');
    process.env.DATABASE_URL = env.DATABASE_URL;
    try {
      const pw = (getPool() as unknown as { options: { password: () => Promise<string> } }).options
        .password;
      expect(await pw()).toBe('signed-iam-token');
    } finally {
      await closePool();
      delete process.env.DATABASE_URL;
      resetPoolDefaults();
    }
  });

  it('the pool verifies the server: ssl = CA + rejectUnauthorized, never relaxed (M3)', () => {
    const ca = Buffer.from('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n');
    expect(toPgSsl({ ca })).toEqual({ ca, rejectUnauthorized: true, minVersion: 'TLSv1.2' });
    expect(toPgSsl(undefined)).toBeUndefined(); // local Docker only
    expect(sslFromEnv({}, () => ca)).toBeUndefined();
    expect(
      sslFromEnv({ PG_SSL_CA_FILE: '/x.pem' }, (p) => (p === '/x.pem' ? ca : Buffer.alloc(0))),
    ).toEqual({ ca });
  });

  it('copies JSON secret keys to env, skipping placeholders and existing values', async () => {
    const env: NodeJS.ProcessEnv = { SECRET_ARNS: 'a, b', STRAVA_CLIENT_ID: 'from-env' };
    await loadSecretsIntoEnv({
      env,
      client: secretsClient({
        a: { STRAVA_CLIENT_ID: 'from-secret', STRAVA_CLIENT_SECRET: PLACEHOLDER, EMPTY: '' },
        b: { NEXTAUTH_SECRET: 's3cret', NOT_A_STRING: 5 },
      }),
    });
    expect(env.STRAVA_CLIENT_ID).toBe('from-env');
    expect(env.STRAVA_CLIENT_SECRET).toBeUndefined();
    expect(env.EMPTY).toBeUndefined();
    expect(env.NEXTAUTH_SECRET).toBe('s3cret');
    expect(env.NOT_A_STRING).toBeUndefined();
  });

  it('does nothing (and builds no client) when no ARNs are configured', async () => {
    await expect(loadSecretsIntoEnv({ env: {} })).resolves.toBeUndefined();
  });

  it('never leaks secret material in errors', async () => {
    const client = { send: vi.fn(async () => ({ SecretString: 'not-json-hunter2' })) };
    const err = await loadSecretsIntoEnv({ env: { SECRET_ARNS: 'x' }, client }).catch((e) => e);
    expect(String(err)).not.toContain('hunter2');
    expect(() => databaseUrlFromSecret({ username: 'u' })).toThrow(/missing fields/);
  });

  it('memoises per container but retries after a failure', async () => {
    vi.stubEnv('SECRET_ARNS', 'a');
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ SecretString: '{"FOO_BAR_TEST":"1"}' });
    await expect(ensureBootstrapped({ client: { send } })).rejects.toThrow('boom');
    await ensureBootstrapped({ client: { send } });
    await ensureBootstrapped({ client: { send } });
    expect(send).toHaveBeenCalledTimes(2);
    delete process.env.FOO_BAR_TEST;
  });
});

describe('webhook-ttl', () => {
  it('defaults to 30 days, honours env and event overrides, rejects junk', () => {
    expect(resolveDays(undefined, {})).toBe(DEFAULT_TTL_DAYS);
    expect(DEFAULT_TTL_DAYS).toBe(30);
    expect(resolveDays(undefined, { WEBHOOK_TTL_DAYS: '14' })).toBe(14);
    expect(resolveDays(7, { WEBHOOK_TTL_DAYS: '14' })).toBe(7);
    expect(resolveDays(-1, { WEBHOOK_TTL_DAYS: 'abc' })).toBe(30);
    expect(resolveDays(0, {})).toBe(30);
  });

  it('deletes by received_at with a bound parameter and returns the count', async () => {
    const query = vi.fn(async () => ({ rowCount: 3 }));
    const n = await deleteOldWebhookEvents({ query } as never, 30);
    expect(n).toBe(3);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/DELETE FROM webhook_events WHERE received_at < now\(\)/);
    expect(params).toEqual([30]);
  });
});

describe('strava-replay', () => {
  it('replays pending/failed Strava events with env-tunable limits', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const out = await runReplay({ pool: { query } as never, ingest: {} as never }, {
      STRAVA_REPLAY_LIMIT: '10',
      STRAVA_REPLAY_PENDING_AFTER_SEC: '60',
    } as NodeJS.ProcessEnv);
    expect(out).toEqual({ replayed: 0 });
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("provider = 'strava'");
    expect(params).toEqual([10, 60]);
  });

  it('replays a pending event through the ingest service and marks it processed', async () => {
    const ev = { object_type: 'activity', object_id: 7, aspect_type: 'create', owner_id: 1 };
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: 'e1', user_id: 'u1', payload_jsonb: ev }] })
      .mockResolvedValue({ rows: [] });
    const ingestActivity = vi.fn(async () => undefined);
    const out = await runReplay({
      pool: { query } as never,
      ingest: { ingestActivity } as never,
    });
    expect(out.replayed).toBe(1);
    expect(ingestActivity).toHaveBeenCalledWith('u1', 7);
    expect(query.mock.calls[1]![1]).toEqual(['e1', 'processed']);
  });
});

describe('migrate', () => {
  it('requires DATABASE_URL', async () => {
    await expect(migrate({} as NodeJS.ProcessEnv)).rejects.toThrow(/DATABASE_URL/);
  });
});

describe('webhooks lambda app', () => {
  it('mounts only the configured providers', async () => {
    vi.stubEnv('STRAVA_WEBHOOK_VERIFY_TOKEN', 'v-token');
    vi.stubEnv('TOKEN_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    const strava = createWebhooksApp(['strava']);
    const q = { 'hub.mode': 'subscribe', 'hub.verify_token': 'v-token', 'hub.challenge': 'c' };
    const ok = await request(strava).get('/api/v1/webhooks/strava').query(q);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ 'hub.challenge': 'c' });
    // terra is NOT mounted on the strava function, nor is the REST API.
    expect((await request(strava).post('/api/v1/webhooks/terra').send({})).status).toBe(404);
    expect((await request(strava).get('/api/v1/health')).status).toBe(404);
  });

  it('terra rejects an unsigned body before touching the payload (rule 7)', async () => {
    vi.stubEnv('TERRA_SIGNING_SECRET', 'sig');
    const res = await request(createWebhooksApp(['terra']))
      .post('/api/v1/webhooks/terra')
      .set('content-type', 'application/json')
      .send('{"type":"activity"}');
    expect(res.status).toBe(401);
  });

  it('refuses to start with no/unknown providers', () => {
    expect(() => createWebhooksApp([])).toThrow(/WEBHOOK_PROVIDERS/);
    expect(() => createWebhooksApp(['nope'])).toThrow(/WEBHOOK_PROVIDERS/);
  });
});

describe('strava replay kick (webhooks lambda)', () => {
  const post = {
    rawPath: '/api/v1/webhooks/strava',
    requestContext: { http: { method: 'POST' } },
  };
  const env = { STRAVA_REPLAY_FUNCTION: 'rd-dev-strava-replay' } as NodeJS.ProcessEnv;

  it('async-invokes the replay function after a 200 Strava POST', async () => {
    const send = vi.fn(async (_cmd: unknown) => ({}));
    expect(await kickStravaReplay(post, 200, env, { send })).toBe(true);
    const cmd = send.mock.calls[0]![0] as { input: Record<string, unknown> };
    expect(cmd.input.FunctionName).toBe('rd-dev-strava-replay');
    expect(cmd.input.InvocationType).toBe('Event');
    expect(JSON.parse(Buffer.from(cmd.input.Payload as Uint8Array).toString())).toEqual({
      pendingAfterSec: 0,
    });
  });

  it('does nothing for GET handshakes, non-200s, other paths, or when unconfigured', async () => {
    const send = vi.fn(async () => ({}));
    const get = { ...post, requestContext: { http: { method: 'GET' } } };
    const terra = { ...post, rawPath: '/api/v1/webhooks/terra' };
    expect(await kickStravaReplay(get, 200, env, { send })).toBe(false);
    expect(await kickStravaReplay(post, 403, env, { send })).toBe(false);
    expect(await kickStravaReplay(terra, 200, env, { send })).toBe(false);
    expect(await kickStravaReplay(post, 200, {} as NodeJS.ProcessEnv, { send })).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('swallows invoke failures (the fallback schedule covers them)', async () => {
    const send = vi.fn().mockRejectedValue(new Error('AccessDenied'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await kickStravaReplay(post, 200, env, { send })).toBe(false);
  });

  it('replay honours an event-supplied pendingAfterSec of 0', async () => {
    const query = vi.fn(async (_sql: string, _params: unknown[]) => ({ rows: [] }));
    await runReplay({ pool: { query } as never, ingest: {} as never }, {}, { pendingAfterSec: 0 });
    expect(query.mock.calls[0]![1]).toEqual([25, 0]);
  });
});
