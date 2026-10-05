// Runtime secrets for the deployed web app (stage E item: NEXTAUTH_SECRET used to be written into
// apps/web/.env.production during the Amplify build, i.e. into build artifacts).
//
// Now the build only writes ARNs (not secret). At server start, instrumentation.ts calls
// `loadRuntimeSecrets()`, which reads those Secrets Manager entries with the Amplify SSR compute
// role (infra/cdk web-stack) and puts the values in process.env, in memory only. Locally, in tests
// and in e2e the variables are already set, so nothing is fetched.
// https://docs.aws.amazon.com/amplify/latest/userguide/amplify-SSR-compute-role.html

export const PLACEHOLDER = 'REPLACE_ME';

export interface SecretsReader {
  send(command: unknown): Promise<{ SecretString?: string }>;
}

/** Secret keys the web app may take from Secrets Manager. Anything else in a secret is ignored. */
const ALLOWED_KEYS = new Set(['NEXTAUTH_SECRET', 'AUTH_GOOGLE_ID', 'AUTH_GOOGLE_SECRET']);

/** arn:aws:secretsmanager:<region>:<account>:secret:<name> -> region */
export const regionOfArn = (arn: string): string | undefined => arn.split(':')[3] || undefined;

let loading: Promise<void> | undefined;

export function loadRuntimeSecrets(
  env: Record<string, string | undefined> = process.env,
  client?: SecretsReader,
): Promise<void> {
  const arns = (env.RUNTIME_SECRET_ARNS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (arns.length === 0) return Promise.resolve();
  loading ??= (async () => {
    const { SecretsManagerClient, GetSecretValueCommand } =
      await import('@aws-sdk/client-secrets-manager');
    for (const arn of arns) {
      const c = client ?? new SecretsManagerClient({ region: regionOfArn(arn) });
      const out = await c.send(new GetSecretValueCommand({ SecretId: arn }));
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(out.SecretString ?? '{}') as Record<string, unknown>;
      } catch {
        throw new Error('runtime secret is not valid JSON'); // never echo the value
      }
      for (const [k, v] of Object.entries(parsed)) {
        if (!ALLOWED_KEYS.has(k) || typeof v !== 'string' || v === '' || v === PLACEHOLDER)
          continue;
        env[k] ??= v;
        // Auth.js reads AUTH_SECRET; the API token minting reads NEXTAUTH_SECRET. Same value.
        if (k === 'NEXTAUTH_SECRET') env.AUTH_SECRET ??= v;
      }
    }
  })().catch((err: unknown) => {
    loading = undefined; // let the next request retry
    throw err;
  });
  return loading;
}

/** Test hook. */
export function resetRuntimeSecretsForTests(): void {
  loading = undefined;
}
