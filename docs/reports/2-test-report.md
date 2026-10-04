# Phase 2 test report — connection framework

Run: `pnpm db:migrate && pnpm typecheck && pnpm lint && pnpm test` → all green, 14 files / 105 tests.

## Spec coverage
| Requirement | Test |
|---|---|
| Migrations match PLAN §7 (unique keys, indexes, CHECKs, cascade, user_id, derivation_version) | `connections/schema.test.ts` (added) |
| Registry lookup by provider+role, dup rejection | `provider-adapters/src/registry.test.ts` |
| Precedence: Oura-first default, overridable | `precedence.test.ts`, `connections.test.ts` |
| Idempotent upsert twice = one row (daily + activity) | `connections.test.ts` SyncService |
| Only one activity source (service + DB partial unique index) | `connections.test.ts` ConnectionConfigService |
| Disconnect deletes tokens + that provider's rows only, per-user | `connections.test.ts` disconnect + route |
| TokenCipher AES-GCM round-trip/tamper/key checks, KMS stub | `crypto/crypto.test.ts` |
| Routes start/callback/DELETE/config; 401; cross-user isolation; OAuth state | `connections.test.ts` routes |
| SyncService uses only configured active adapters, isolates failures | `connections.test.ts` |

## Failures
None.

## Risks / untested
- KMS implementation is a stub; real KMS untested.
- `webhook_events` only schema-tested (no code uses it yet).
- No explicit assertion that tokens never appear in logs for the new connection routes (error path returns no payload details is tested).
- Concurrent sync races not tested.
