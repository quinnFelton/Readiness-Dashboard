import { afterEach, describe, expect, it, vi } from 'vitest';

// node-pg-migrate is mocked: no database is touched (CLAUDE.md rule 10 spirit; CI has Postgres but
// the Lambda wrapper's behaviour — args, retry while Aurora resumes — doesn't need one).
const runner = vi.fn();
vi.mock('node-pg-migrate', () => ({ runner: (opts: unknown) => runner(opts) }));

import { migrate } from './migrate';

const env = { DATABASE_URL: 'postgres://u:p@h:5432/db?sslmode=no-verify' } as NodeJS.ProcessEnv;

afterEach(() => runner.mockReset());

describe('migrate lambda', () => {
  it('runs all pending migrations up from the bundled directory', async () => {
    runner.mockResolvedValue([{ name: '1_a' }, { name: '2_b' }]);
    const out = await migrate(env, { dir: '/var/task/migrations' });
    expect(out).toEqual({ applied: ['1_a', '2_b'] });
    const opts = runner.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts).toMatchObject({
      dir: '/var/task/migrations',
      direction: 'up',
      migrationsTable: 'pgmigrations', // same table the local CLI (`pnpm db:migrate`) uses
    });
    expect(opts.databaseUrl).toMatchObject({ connectionString: env.DATABASE_URL });
    expect(opts.count).toBeUndefined(); // all pending, not just one
  });

  it('defaults the directory to <cwd>/migrations (Lambda task root)', async () => {
    runner.mockResolvedValue([]);
    await migrate(env);
    expect((runner.mock.calls[0]![0] as { dir: string }).dir).toBe(`${process.cwd()}/migrations`);
  });

  it('retries transient connection errors (Aurora resuming from auto-pause)', async () => {
    runner
      .mockRejectedValueOnce(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }))
      .mockRejectedValueOnce(new Error('Connection terminated due to connection timeout'))
      .mockResolvedValue([{ name: '1_a' }]);
    const out = await migrate(env, { dir: 'd', retryDelayMs: 0 });
    expect(out.applied).toEqual(['1_a']);
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it('does not retry real migration failures', async () => {
    runner.mockRejectedValue(new Error('syntax error at or near "CREAT"'));
    await expect(migrate(env, { dir: 'd', retryDelayMs: 0 })).rejects.toThrow(/syntax error/);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('gives up after the configured attempts', async () => {
    runner.mockRejectedValue(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }));
    await expect(migrate(env, { dir: 'd', retryDelayMs: 0, attempts: 2 })).rejects.toThrow('x');
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('requires DATABASE_URL', async () => {
    await expect(migrate({} as NodeJS.ProcessEnv)).rejects.toThrow(/DATABASE_URL/);
    expect(runner).not.toHaveBeenCalled();
  });
});
