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
import { migrate } from './migrate';
import { runReplay } from './strava-replay';
import { DEFAULT_TTL_DAYS, deleteOldWebhookEvents, resolveDays } from './webhook-ttl';
import { createWebhooksApp } from './webhooks';

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
  it('builds DATABASE_URL from the DB secret, url-encoding the credentials', async () => {
    const env: NodeJS.ProcessEnv = { DB_SECRET_ARN: 'db' };
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
    expect(env.DATABASE_URL).toBe(
      'postgres://rd%20admin:p%40ss%2Fw%3Ard@h.example:5432/readiness?sslmode=no-verify',
    );
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
