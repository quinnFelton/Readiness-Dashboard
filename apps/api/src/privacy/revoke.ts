import type { AdapterRegistry } from '@rd/provider-adapters';
import type pg from 'pg';
import type { TokenCipher } from '../crypto/token-cipher';

// Security review M1 / PLAN §12: ending a connection must end the grant at the provider too, or a
// token copied earlier (backup, snapshot) stays usable and the provider keeps pushing events.
// Best effort: a provider outage must never block the user's own delete/disconnect, so failures are
// reported per provider instead of thrown. Tokens are decrypted only for the call and never logged;
// errors are reduced to their class name (messages and URLs may carry token material, rule 6).

export type RevokeOutcome = 'revoked' | 'failed' | 'skipped';

export interface RevokeDeps {
  pool: pg.Pool;
  registry: AdapterRegistry;
  cipher: TokenCipher;
  /** Per-provider time limit. Default PRIVACY_REVOKE_TIMEOUT_MS or 5000 (rule 9: config). */
  timeoutMs?: number;
}

interface ConnRow {
  provider: string;
  external_user_id: string | null;
  access_token_enc: Buffer | null;
  refresh_token_enc: Buffer | null;
}

export function revokeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PRIVACY_REVOKE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 5000;
}

/**
 * Revokes this user's grants at the provider (all of them, or only `providers`). Does not touch the
 * database rows: the caller deletes them in its own transaction.
 */
export async function revokeProviderGrants(
  deps: RevokeDeps,
  userId: string,
  providers?: readonly string[],
): Promise<Record<string, RevokeOutcome>> {
  const { rows } = await deps.pool.query<ConnRow>(
    `SELECT provider, external_user_id, access_token_enc, refresh_token_enc
       FROM provider_connections
      WHERE user_id = $1 AND ($2::text[] IS NULL OR provider = ANY($2))`,
    [userId, providers ? [...providers] : null],
  );
  const timeoutMs = deps.timeoutMs ?? revokeTimeoutMs();
  const out: Record<string, RevokeOutcome> = {};
  await Promise.all(
    rows.map(async (row) => {
      out[row.provider] = await revokeOne(deps, userId, row, timeoutMs);
    }),
  );
  return out;
}

async function revokeOne(
  deps: RevokeDeps,
  userId: string,
  row: ConnRow,
  timeoutMs: number,
): Promise<RevokeOutcome> {
  const adapter = deps.registry.getByProvider(row.provider);
  if (!adapter?.revoke) return 'skipped';
  // Nothing to revoke for a connection that was already deauthorized (tokens nulled), except for
  // widget providers (Terra), whose grant is identified by external_user_id rather than a token.
  const tokenless = adapter.connectFlow === 'widget';
  const hasToken = !!row.access_token_enc || !!row.refresh_token_enc;
  if (tokenless ? !row.external_user_id : !hasToken) return 'skipped';
  let timer: NodeJS.Timeout | undefined;
  try {
    const ctx = `${userId}:${row.provider}`;
    const accessToken = row.access_token_enc
      ? await deps.cipher.decrypt(row.access_token_enc, ctx)
      : undefined;
    const refreshToken = row.refresh_token_enc
      ? await deps.cipher.decrypt(row.refresh_token_enc, ctx)
      : undefined;
    await Promise.race([
      adapter.revoke({ externalUserId: row.external_user_id, accessToken, refreshToken }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('revoke timeout')), timeoutMs);
      }),
    ]);
    return 'revoked';
  } catch (err) {
    console.warn(
      `provider revoke failed (${row.provider}): ${err instanceof Error ? err.name : 'error'}`,
    );
    return 'failed';
  } finally {
    clearTimeout(timer);
  }
}
