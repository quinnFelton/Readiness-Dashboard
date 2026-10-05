import type { ConnectionRole } from '@rd/shared-types';

// PLAN §6. The core contract is `normalize`; the remaining methods let the framework
// dispatch connect/sync without any provider-specific code in apps/api.

/** Tokens/identity an adapter obtained from a completed connect flow. Plaintext; the API encrypts. */
export interface ConnectionGrant {
  externalUserId?: string;
  accessToken?: string; // absent for push-only providers (e.g. Terra widget flow)
  refreshToken?: string;
  expiresAt?: Date;
}

export interface StartContext {
  userId: string;
  /** Opaque, signed by the API; the adapter must pass it through to the provider unchanged. */
  state: string;
}
export interface StartResult {
  /** OAuth authorize URL or hosted-widget URL the client should open. */
  redirectUrl: string;
}

export interface CallbackContext {
  userId: string;
  /** Raw query params from the provider redirect (state already verified by the API). */
  query: Record<string, string | undefined>;
}

export interface FetchContext {
  userId: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: Date | null;
  externalUserId?: string | null;
  /** Last successful sync; adapters fetch only what is new since then. */
  since: Date | null;
}
export interface FetchResult {
  /** Raw provider payload, handed straight to `normalize` and then discarded (PLAN §13). */
  raw: unknown;
  /** Present when the adapter refreshed the OAuth tokens during the fetch. */
  refreshedGrant?: ConnectionGrant;
}

/** Plaintext credentials of one connection, decrypted just for a revoke call. Never log. */
export interface RevokeContext {
  externalUserId?: string | null;
  accessToken?: string;
  refreshToken?: string;
}

export interface ProviderAdapter<T> {
  role: ConnectionRole;
  /** "oura", "strava", "terra", future: "garmin", ... */
  key: string;
  /** Shown in the connections screen. Defaults to the key. */
  displayName?: string;
  /** How `start` connects: an OAuth redirect (default) or a hosted widget (Terra). */
  connectFlow?: 'oauth' | 'widget';
  /** Bump when parsing logic changes (PLAN §13). Defaults to 1. */
  derivationVersion?: number;
  /** Pure: raw provider payload -> normalized rows. Must not do I/O. */
  normalize(rawPayload: unknown): T[];
  start(ctx: StartContext): Promise<StartResult>;
  handleCallback(ctx: CallbackContext): Promise<ConnectionGrant>;
  /** Optional: push-only providers (Terra) deliver via webhook and omit this. */
  fetchRaw?(ctx: FetchContext): Promise<FetchResult>;
  /**
   * Optional (phase 9, security review M1): ends the grant at the provider so a token copied earlier
   * stops working and the provider stops pushing events. Callers treat it as best effort and bound
   * it with a timeout; implementations must not log or embed the tokens in thrown errors.
   */
  revoke?(ctx: RevokeContext): Promise<void>;
}
