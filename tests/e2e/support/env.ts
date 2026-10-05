// Single source of truth for e2e ports, secrets and provider env. Imported by playwright.config.ts
// (to start the servers), by the launcher/seed child processes, and by specs. E2E values only:
// nothing here is a real credential, and no spec or server reaches a real provider.

export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3100);
export const API_PORT = Number(process.env.E2E_API_PORT ?? 4100);
export const WEB_URL = `http://localhost:${WEB_PORT}`;
export const API_URL = `http://localhost:${API_PORT}`;

export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://rd:rd@localhost:5432/readiness';

export const NEXTAUTH_SECRET = 'e2e-nextauth-secret-not-for-production';
// 32 bytes, base64 (TokenCipher + OAuth state signing).
export const TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
export const AUTH_DEV_PASSWORD = 'e2e-password';
export const TERRA_SIGNING_SECRET = 'e2e-terra-signing-secret';

/** Env for the API process (and the seed, which shares its modules). */
export function apiEnv(): Record<string, string> {
  return {
    NODE_ENV: 'test', // the dev login route is disabled when NODE_ENV=production
    PORT: String(API_PORT),
    DATABASE_URL,
    NEXTAUTH_SECRET,
    TOKEN_ENCRYPTION_KEY,
    AUTH_DEV_PASSWORD,
    OURA_CLIENT_ID: 'e2e-oura-client',
    OURA_CLIENT_SECRET: 'e2e-oura-secret',
    OURA_USE_SANDBOX: 'false',
    OURA_REDIRECT_URI: `${WEB_URL}/settings/connections/oura/callback`,
    STRAVA_CLIENT_ID: 'e2e-strava-client',
    STRAVA_CLIENT_SECRET: 'e2e-strava-secret',
    STRAVA_REDIRECT_URI: `${WEB_URL}/settings/connections/strava/callback`,
    TERRA_DEV_ID: 'e2e-terra-dev',
    TERRA_API_KEY: 'e2e-terra-key',
    TERRA_SIGNING_SECRET,
    // Same defaults as .env.example: Terra's widget returns to /settings.
    TERRA_SUCCESS_REDIRECT_URL: `${WEB_URL}/settings`,
    TERRA_FAILURE_REDIRECT_URL: `${WEB_URL}/settings`,
    TERRA_PROVIDERS: 'ZEPP',
  };
}

/** Env for `next build` / `next start` / `next dev`. */
export function webEnv(): Record<string, string> {
  return {
    API_URL,
    NEXTAUTH_SECRET,
    AUTH_SECRET: NEXTAUTH_SECRET,
    NEXTAUTH_URL: WEB_URL,
    AUTH_URL: WEB_URL,
    AUTH_TRUST_HOST: 'true',
    TOKEN_ENCRYPTION_KEY,
  };
}

/** Seed accounts (apps/api/db/seed/accounts.ts) and what each e2e flow uses them for. */
export const USERS = {
  /** Read-only: has data. Dashboard (flow 5) and the RBAC negative tests (flow 7). */
  viewer: 'user01@example.test',
  /** Mutated by flow 8 only: has data and Oura + Strava connected. */
  disconnecter: 'user02@example.test',
  /** Mutated by flow 2 only: no connections. */
  ouraConnector: 'user03@example.test',
  /** Mutated by flow 3 only. */
  stravaConnector: 'user04@example.test',
  /** Mutated by flow 4 only. */
  terraConnector: 'user05@example.test',
  /** Has an account but no data or connections (empty state). */
  empty: 'user06@example.test',
  master: 'master@example.test',
} as const;

export const ALL_LOGIN_USERS = Object.values(USERS);

/** storageState file for a seeded account. */
export const authFile = (email: string): string => `test-results/.auth/${email.split('@')[0]}.json`;
