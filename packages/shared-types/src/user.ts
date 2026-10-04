// PLAN §2 / §7 — app-level users and roles.
export type UserRole = 'user' | 'master';

export interface User {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  createdAt: string; // ISO 8601
}

/** Claims in the short-lived JWT the web app mints for API calls (see apps/api/src/auth/README.md). */
export interface ApiTokenClaims {
  sub: string; // users.id
  role: UserRole; // advisory only — the API re-reads the role from the DB
  iss: 'rd-web';
  aud: 'rd-api';
  iat: number;
  exp: number;
}
