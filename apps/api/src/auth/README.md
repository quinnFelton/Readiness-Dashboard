# API authentication

**Mechanism: web-minted, short-lived HS256 JWT in `Authorization: Bearer`.**

1. User signs in via NextAuth (apps/web). The Credentials provider (dev) calls
   `POST /api/v1/auth/login`, which checks `AUTH_DEV_PASSWORD` (constant-time; disabled when
   `NODE_ENV=production` or the var is unset) and returns the `users` row. Users live in
   Postgres. The provider is swappable (e.g. email magic link); the API doesn't care.
2. NextAuth keeps a JWT session cookie carrying `uid` + `role` (used by `apps/web/middleware.ts`
   to guard `/admin` without a DB hop).
3. Server Components call the API via `apiFetch` (`apps/web/src/lib/auth/api-fetch.ts`), which
   mints a 5-minute token: `{ sub: users.id, role, iss: "rd-web", aud: "rd-api", iat, exp }`,
   signed HS256 with `NEXTAUTH_SECRET`. Tokens never reach the browser.
4. `requireUser` (apps/api/src/middleware/rbac.ts) verifies signature (constant-time), only
   accepts `alg=HS256`, checks `iss`/`aud`/`exp`, then **loads the user from Postgres**.
   `req.user.role` comes from the DB — the token's `role` claim is advisory and never trusted,
   so demotions/deletions apply immediately. Failures → `401`.

## Middleware

| Middleware | Behavior |
|---|---|
| `requireUser` | 401 unless valid token + existing user |
| `requireMaster` | after `requireUser`; 403 unless `role = master` |
| `requireSelfOrMaster(param)` | after `requireUser`; master any, user only if `req.params[param] === req.user.id`, else 403 (missing param fails closed) |

Every route must compose these explicitly, e.g.
`router.get('/:userId', requireUser, requireSelfOrMaster('userId'), handler)`.

## Env
`NEXTAUTH_SECRET` (shared by web + api), `AUTH_DEV_PASSWORD` (dev only), `DATABASE_URL`.
