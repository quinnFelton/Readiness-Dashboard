import type { UserRole } from '@rd/shared-types';
import type { NextAuthConfig } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';

// Edge-safe (fetch only, no pg / node:crypto) so middleware.ts can import it.
// Provider is swappable: replace `Credentials` with an Email/magic-link provider and keep
// the `jwt`/`session` callbacks — the only contract is that the token carries `uid` + `role`.
//
// Session strategy is JWT (not DB sessions): middleware must read the role without a DB
// round trip, and the API re-reads the role from Postgres on every request anyway
// (apps/api/src/auth/README.md). Users live in Postgres `users`.

const API_URL = process.env.API_URL ?? 'http://localhost:4000';

interface LoginResponse {
  user?: { id: string; email: string; name: string | null; role: UserRole };
}

export const authConfig = {
  session: { strategy: 'jwt', maxAge: 60 * 60 * 8 },
  pages: { signIn: '/login' },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      // Dev credentials login, delegated to POST /api/v1/auth/login (disabled in production).
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
  ],
  callbacks: {
    jwt({ token, user }) {
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
