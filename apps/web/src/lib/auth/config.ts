import type { UserRole } from '@rd/shared-types';
import type { NextAuthConfig } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
import { resolveUserByEmail } from './identity';

// Edge-safe (fetch + Web Crypto only, no pg / node:crypto) so middleware.ts can import it.
//
// Providers (security review H3):
//  * Google OAuth: the production login. Only people already in `users` can sign in; the API maps the
//    verified Google email to a user (POST /auth/oauth-identity, HMAC-authenticated). No
//    auto-provisioning: the master adds an athlete by creating their `users` row.
//  * Dev Credentials (shared password): registered only when no deployment stage is configured.
//    AWS builds always set STAGE (infra/cdk web-stack), so this provider does not exist there. The API
//    independently refuses /auth/login when NODE_ENV=production or AUTH_DEV_PASSWORD is unset.
//
// The only contract with the rest of the app is that the JWT carries `uid` + `role`.
// Session strategy is JWT (not DB sessions): middleware must read the role without a DB round trip,
// and the API re-reads the role from Postgres on every request anyway (apps/api/src/auth/README.md).

const API_URL = process.env.API_URL ?? 'http://localhost:4000';

/** True in any AWS deployment (STAGE=dev|prod comes from the CDK); false locally, in tests and e2e. */
export const isDeployedStage = (env: NodeJS.ProcessEnv = process.env): boolean => !!env.STAGE;

interface LoginResponse {
  user?: { id: string; email: string; name: string | null; role: UserRole };
}

const authSecret = (): string | undefined => process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET;

async function googleIdentity(
  profile: { email?: string | null; email_verified?: unknown } | undefined,
) {
  const secret = authSecret();
  if (!profile?.email || profile.email_verified !== true || !secret) return null;
  return resolveUserByEmail(profile.email, { apiUrl: API_URL, secret });
}

export const authConfig = {
  session: { strategy: 'jwt', maxAge: 60 * 60 * 8 },
  pages: { signIn: '/login' },
  providers: [
    ...(isDeployedStage()
      ? []
      : [
          Credentials({
            credentials: { email: {}, password: {} },
            // Dev credentials login, delegated to POST /api/v1/auth/login (404 in production).
            async authorize(credentials) {
              const { email, password } = credentials ?? {};
              if (typeof email !== 'string' || typeof password !== 'string') return null;
              const res = await fetch(`${API_URL}/api/v1/auth/login`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ email, password }),
                cache: 'no-store',
              });
              if (!res.ok) return null;
              const { user } = (await res.json()) as LoginResponse;
              if (!user) return null;
              return { id: user.id, email: user.email, name: user.name, role: user.role };
            },
          }),
        ]),
    // Client id/secret come from AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET (Secrets Manager at runtime).
    Google,
  ],
  callbacks: {
    // Refuse a Google sign-in for anyone who is not an existing user, or whose email Google has not
    // verified. (Credentials already proved itself in `authorize`.)
    async signIn({ account, profile }) {
      if (account?.provider !== 'google') return true;
      return (await googleIdentity(profile)) !== null;
    },
    jwt({ token, user, account, profile }) {
      if (account?.provider === 'google') {
        // Re-resolve here instead of trusting anything mutated in `signIn`: uid/role come from the API.
        return googleIdentity(profile).then((u) => {
          if (!u) throw new Error('unknown user'); // fail closed: no session without a users row
          token.uid = u.id;
          token.role = u.role;
          return token;
        });
      }
      if (user) {
        token.uid = user.id;
        token.role = (user as { role?: UserRole }).role ?? 'user';
      }
      return token;
    },
    session({ session, token }) {
      session.user.id = token.uid as string;
      session.user.role = (token.role as UserRole | undefined) ?? 'user';
      return session;
    },
  },
} satisfies NextAuthConfig;
