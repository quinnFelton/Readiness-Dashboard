// Aurora IAM database authentication (stage E item: per-function Postgres roles, PLAN §11).
//
// Each function connects as its OWN database user (DB_IAM_USER, e.g. rd_hook_strava; created and
// granted by the phase-9 migration). There is no database password for that user at all: the
// "password" is a token signed with the function's IAM role, valid for 15 minutes and only checked at
// connect time, and the role's policy allows rds-db:connect for exactly that one db user
// (infra/cdk api-stack). Compromising one function therefore yields neither the master credential nor
// another function's access. The master password exists only for the `migrate` function.
// https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/UsingWithRDS.IAMDBAuth.html

export interface IamAuthEnv {
  DB_IAM_USER?: string;
  DB_HOST?: string;
  DB_PORT?: string;
  DB_NAME?: string;
  AWS_REGION?: string;
}

/** postgres://user@host:port/db — no password; pool.ts supplies the token per connection. */
export function iamDatabaseUrl(env: IamAuthEnv): string {
  const { DB_IAM_USER: user, DB_HOST: host, DB_NAME: db } = env;
  if (!user || !host || !db) throw new Error('DB_IAM_USER, DB_HOST and DB_NAME are required');
  return `postgres://${encodeURIComponent(user)}@${host}:${env.DB_PORT ?? '5432'}/${encodeURIComponent(db)}`;
}

export interface TokenSigner {
  getAuthToken(): Promise<string>;
}

/** A password provider for pool.ts. A fresh token per new connection (tokens are cheap, local SigV4). */
export async function iamPasswordProvider(
  env: IamAuthEnv,
  signer?: TokenSigner,
): Promise<() => Promise<string>> {
  const s =
    signer ??
    (await (async () => {
      const { Signer } = await import('@aws-sdk/rds-signer');
      return new Signer({
        hostname: env.DB_HOST as string,
        port: Number(env.DB_PORT ?? 5432),
        username: env.DB_IAM_USER as string,
        region: env.AWS_REGION,
      });
    })());
  return () => s.getAuthToken();
}
