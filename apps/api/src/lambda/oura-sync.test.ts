import { afterEach, describe, expect, it, vi } from 'vitest';

// The Oura sync job itself is covered in providers/oura; here only the Lambda wrapper's failure
// marker (consumed by the CloudWatch metric filter in infra/cdk) is under test. No DB, no network.
const results: Record<string, { ok: boolean; error?: string }> = {};
vi.mock('../providers/oura/sync-job', () => ({
  handler: vi.fn(async () => ({ results })),
}));

import { SYNC_FAILURE_MARKER, handler } from './oura-sync';

afterEach(() => {
  for (const k of Object.keys(results)) delete results[k];
  vi.restoreAllMocks();
});

describe('oura-sync lambda', () => {
  it('logs a counts-only marker when a user sync failed', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    results['user-1'] = { ok: true };
    results['user-2'] = { ok: false, error: 'FetchError' };
    results['user-3'] = { ok: false, error: 'NotConnected' }; // benign
    results['user-4'] = { ok: false, error: 'SyncInProgress' }; // benign
    await handler();
    expect(err).toHaveBeenCalledTimes(1);
    const line = String(err.mock.calls[0]![0]);
    expect(line).toBe(`${SYNC_FAILURE_MARKER} {"failed":1}`);
    expect(line).not.toContain('user-2'); // no user ids in logs
  });

  it('stays silent when everything succeeded or was benign', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    results['user-1'] = { ok: true };
    results['user-2'] = { ok: false, error: 'NotConnected' };
    const out = await handler();
    expect(err).not.toHaveBeenCalled();
    expect(out.results).toBe(results);
  });
});
