import NextAuth from 'next-auth';
import { NextResponse } from 'next/server';
import { decideAdminAccess } from './src/lib/auth/admin-guard';
import { authConfig } from './src/lib/auth/config';

// PLAN §9: block /admin for non-master sessions. Defense in depth: the API also 403s
// (requireMaster) so bypassing this middleware gains nothing.
// NOTE: Next 16 may prefer `proxy.ts` over `middleware.ts` — see report; same body works.
const { auth } = NextAuth(authConfig);

export default auth((req) => {
  const decision = decideAdminAccess(req.auth);
  if (decision.action === 'allow') return NextResponse.next();
  return NextResponse.redirect(new URL(decision.to, req.nextUrl));
});

export const config = { matcher: ['/admin/:path*'] };
