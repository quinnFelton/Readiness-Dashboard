import type {
  CallbackContext,
  ConnectionGrant,
  FetchContext,
  FetchResult,
  ProviderAdapter,
  StartContext,
  StartResult,
} from '@rd/provider-adapters';
import type { ConnectionRole } from '@rd/shared-types';

/**
 * In-memory adapter for TESTS ONLY — no network. Raw payload is already `T[]` minus identity,
 * so `normalize` is a pass-through; SyncService stamps userId/source. Queue what the next fetch
 * returns with `enqueue`. The provider key must still satisfy the DB CHECK ('oura'|'strava'|'terra').
 */
export class FakeAdapter<T> implements ProviderAdapter<T> {
  derivationVersion = 1;
  fetchCalls: FetchContext[] = [];
  private queue: unknown[] = [];

  constructor(
    readonly key: string,
    readonly role: ConnectionRole,
  ) {}

  enqueue(raw: unknown): this {
    this.queue.push(raw);
    return this;
  }

  normalize(raw: unknown): T[] {
    return Array.isArray(raw) ? (raw as T[]) : [];
  }

  async start(ctx: StartContext): Promise<StartResult> {
    return { redirectUrl: `https://fake.invalid/${this.key}/authorize?state=${ctx.state}` };
  }

  async handleCallback(ctx: CallbackContext): Promise<ConnectionGrant> {
    return {
      externalUserId: `ext-${ctx.query.code ?? 'none'}`,
      accessToken: `fake-access-${this.key}`,
      refreshToken: `fake-refresh-${this.key}`,
      expiresAt: new Date('2030-01-01T00:00:00Z'),
    };
  }

  async fetchRaw(ctx: FetchContext): Promise<FetchResult> {
    this.fetchCalls.push(ctx);
    return { raw: this.queue.shift() ?? [] };
  }
}
