// Next.js runs register() once when a server instance starts, before it serves requests
// (docs: node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md;
// with a `src` folder the file lives in src/, next to app/).
// Loads the runtime secrets (NEXTAUTH_SECRET, Google OAuth client) from Secrets Manager into memory.
// No-op unless RUNTIME_SECRET_ARNS is set, i.e. only in the Amplify deployment.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { loadRuntimeSecrets } = await import('./lib/auth/runtime-secrets');
    await loadRuntimeSecrets();
  }
}
