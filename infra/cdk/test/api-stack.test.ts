import { Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { rdsCaBundleCommands } from '../lib/api-stack';
import { actionsOf, asArray, resourcesJson, roleStatements, synth } from './helpers';

const FUNCTIONS = [
  'api',
  'webhook-terra',
  'webhook-strava',
  'webhook-oura',
  'oura-sync',
  'oura-subscriptions',
  'strava-replay',
  'webhook-ttl',
  'history-rebuild',
  'migrate',
] as const;

// How each function logs in to Aurora (stage E: no more shared master credential). `migrate` alone
// uses the master secret (DDL); everyone else is a named least-privilege Postgres role over IAM auth.
const DB_ACCESS: Record<(typeof FUNCTIONS)[number], string | 'master' | null> = {
  api: 'rd_api',
  'webhook-terra': 'rd_hook_terra',
  'webhook-strava': 'rd_hook_strava',
  'webhook-oura': 'rd_hook_oura',
  'oura-sync': 'rd_oura_sync',
  'oura-subscriptions': null,
  'strava-replay': 'rd_strava_replay',
  'webhook-ttl': 'rd_webhook_ttl',
  'history-rebuild': 'rd_history_rebuild',
  migrate: 'master',
};

// Which Secrets Manager entries (by construct id prefix in the data stack) each role may read,
// per the table in api-stack.ts / PLAN §11.
const SECRET_ACCESS: Record<(typeof FUNCTIONS)[number], string[]> = {
  api: ['nextauth', 'oauth-state', 'token-key', 'oura', 'strava', 'terra'],
  'webhook-terra': ['terra', 'token-key'],
  'webhook-strava': ['strava', 'token-key'],
  'webhook-oura': ['oura', 'token-key'],
  'oura-sync': ['oura', 'token-key'],
  'oura-subscriptions': ['oura'],
  'strava-replay': ['strava', 'token-key'],
  'webhook-ttl': [],
  'history-rebuild': [],
  migrate: ['db'], // the master credential: this function only (it runs DDL)
};
const TOKEN_KMS = new Set([
  'api',
  'webhook-terra',
  'webhook-strava',
  'webhook-oura',
  'oura-sync',
  'strava-replay',
]);

const { api, stacks } = synth({ alarmEmail: 'ops@example.com' });

const fnProps = (id: string) => {
  const found = Object.values(api.findResources('AWS::Lambda::Function')).filter(
    (f) => f.Properties.FunctionName === `rd-dev-${id}`,
  );
  expect(found, `function rd-dev-${id}`).toHaveLength(1);
  return found[0]!.Properties;
};

describe('lambdas', () => {
  it('creates exactly the planned functions, each on its own role', () => {
    api.resourceCountIs('AWS::Lambda::Function', FUNCTIONS.length);
    const roleRefs = FUNCTIONS.map((f) => JSON.stringify(fnProps(f).Role));
    expect(new Set(roleRefs).size).toBe(FUNCTIONS.length);
    // + one scheduler-invoke role per schedule; nothing else shares a role.
    api.resourceCountIs('AWS::IAM::Role', FUNCTIONS.length + 5);
  });

  it('sets PG_POOL_MAX=1 and never puts credentials in plaintext env', () => {
    for (const f of FUNCTIONS) {
      const env = fnProps(f).Environment.Variables as Record<string, unknown>;
      expect(env.PG_POOL_MAX, f).toBe('1');
      expect(env.NODE_ENV).toBe('production');
      // Security review H3: the shared-password dev login must not exist in any deployed function
      // (the API also 404s it when NODE_ENV=production), and Lambdas never see the web sign-in secret.
      expect(env.AUTH_DEV_PASSWORD, `${f}: dev login password`).toBeUndefined();
      expect(JSON.stringify(env), `${f}: google oauth secret`).not.toContain('GoogleOAuthSecret');
      for (const key of Object.keys(env)) {
        expect(key, `${f}: ${key}`).not.toMatch(
          /PASSWORD|SECRET$|API_KEY|DATABASE_URL|TOKEN_ENCRYPTION_KEY/,
        );
      }
      // Only ARNs travel in env; the values are fetched from Secrets Manager at cold start.
      expect(JSON.stringify(env)).not.toMatch(/REPLACE_ME/);
    }
    const apiEnv = fnProps('api').Environment.Variables;
    expect(apiEnv.AUTH_DEV_PASSWORD).toBeUndefined(); // dev-only login bypass must never ship
    // The API has NO database secret any more: it is the rd_api Postgres role over IAM auth.
    expect(apiEnv.DB_SECRET_ARN).toBeUndefined();
    expect(fnProps('migrate').Environment.Variables.DB_SECRET_ARN).toBeDefined();
  });

  it('runs in the VPC, except oura-subscriptions which never touches the DB', () => {
    for (const f of FUNCTIONS) {
      const vpc = fnProps(f).VpcConfig;
      if (f === 'oura-subscriptions') expect(vpc).toBeUndefined();
      else expect(vpc, f).toBeDefined();
    }
  });

  it('uses the bundled entrypoints under apps/api/src/lambda', () => {
    for (const f of FUNCTIONS) {
      expect(fnProps(f).Handler).toBe('index.handler');
      expect(fnProps(f).Runtime).toBe('nodejs22.x');
    }
    expect(stacks.api.functions.api).toBeDefined();
  });

  it('webhook functions outlive an Aurora resume (60 s) and select their router via env', () => {
    for (const [fn, provider] of [
      ['webhook-terra', 'terra'],
      ['webhook-strava', 'strava'],
      ['webhook-oura', 'oura'],
    ] as const) {
      expect(fnProps(fn).Timeout).toBe(60);
      expect(fnProps(fn).Environment.Variables.WEBHOOK_PROVIDERS).toBe(provider);
    }
    expect(fnProps('api').Timeout).toBeLessThanOrEqual(29);
  });

  it('ttl default is 30 days and tunable', () => {
    expect(fnProps('webhook-ttl').Environment.Variables.WEBHOOK_TTL_DAYS).toBe('30');
    const t = synth({ webhookTtlDays: 7 }).api.findResources('AWS::Lambda::Function');
    const ttl = Object.values(t).find((f) => f.Properties.FunctionName === 'rd-dev-webhook-ttl');
    expect(ttl?.Properties.Environment.Variables.WEBHOOK_TTL_DAYS).toBe('7');
  });
});

describe('least-privilege IAM (one role per Lambda)', () => {
  it.each(FUNCTIONS)('%s grants only what it needs', (fn) => {
    const stmts = roleStatements(api, `rd-dev-${fn}`);
    const actions = actionsOf(stmts);

    // Never wildcard actions; the only `*` resource is ENI management (Lambda requires it).
    for (const s of stmts) {
      for (const a of asArray(s.Action)) expect(a, `${fn}`).not.toMatch(/\*/);
      if (resourcesJson(s) === '"*"') {
        expect(
          asArray(s.Action).every(
            (a) => a.endsWith('NetworkInterface') || a.endsWith('NetworkInterfaces'),
          ),
        ).toBe(true);
      }
    }

    // Secrets: exactly the entries in the table, nothing more.
    const secretStmts = stmts.filter((s) =>
      asArray(s.Action).some((a) => a.startsWith('secretsmanager:')),
    );
    const secretRefs = secretStmts
      .flatMap((s) => asArray(s.Resource))
      .map((r) => JSON.stringify(r));
    expect(secretRefs).toHaveLength(SECRET_ACCESS[fn].length);
    expect(
      actions
        .filter((a) => a.startsWith('secretsmanager:'))
        .every((a) => /GetSecretValue|DescribeSecret/.test(a)),
    ).toBe(true);

    // KMS: Decrypt only (never Encrypt/GenerateDataKey), pinned to the data-key encryption context.
    const kms = stmts.filter((s) => asArray(s.Action).some((a) => a.startsWith('kms:')));
    if (TOKEN_KMS.has(fn)) {
      expect(kms).toHaveLength(1);
      expect(asArray(kms[0]!.Action)).toEqual(['kms:Decrypt']);
      expect(kms[0]!.Condition).toEqual({
        StringEquals: { 'kms:EncryptionContext:purpose': 'rd-token-data-key' },
      });
    } else {
      expect(kms, `${fn} must not touch KMS`).toHaveLength(0);
    }

    // No RDS control-plane/IAM/S3/etc. grants. The one database-related grant is rds-db:connect, below.
    expect(actions.filter((a) => /^(rds|iam|s3|sts|ssm|sns|sqs|dynamodb|events):/.test(a))).toEqual(
      [],
    );

    // Database login (stage E item): exactly ONE rds-db:connect, for exactly this function's own
    // Postgres role; or the master secret for migrate; or nothing at all.
    const connect = stmts.filter((s) => asArray(s.Action).includes('rds-db:connect'));
    const access = DB_ACCESS[fn];
    if (access === null || access === 'master') {
      expect(connect, `${fn} must not have IAM database access`).toHaveLength(0);
    } else {
      expect(connect, fn).toHaveLength(1);
      expect(asArray(connect[0]!.Action)).toEqual(['rds-db:connect']);
      const resource = JSON.stringify(connect[0]!.Resource);
      expect(resource).toContain('dbuser:');
      expect(resource).toContain(`/${access}`); // that role, not a wildcard, not another
      expect(resource).not.toContain('*');
    }
  });

  it('the master database credential is readable by migrate ONLY (stage E: no shared master)', () => {
    for (const fn of FUNCTIONS) {
      const env = fnProps(fn).Environment.Variables as Record<string, string>;
      const access = DB_ACCESS[fn];
      expect(env.DB_SECRET_ARN !== undefined, `${fn} DB_SECRET_ARN`).toBe(access === 'master');
      if (access !== null && access !== 'master') {
        expect(env.DB_IAM_USER).toBe(access);
        expect(env.DB_NAME).toBe('readiness');
        expect(env.DB_HOST).toBeDefined();
      } else {
        expect(env.DB_IAM_USER).toBeUndefined();
      }
      // Every function that touches the DB verifies the server certificate (security review M3).
      expect(env.PG_SSL_CA_FILE !== undefined, `${fn} PG_SSL_CA_FILE`).toBe(access !== null);
      if (access !== null) expect(env.PG_SSL_CA_FILE).toBe('/var/task/rds-global-bundle.pem');
    }
  });

  it('Aurora has IAM database authentication on, and the master secret rotates (stage E)', () => {
    const { data } = synth();
    data.hasResourceProperties('AWS::RDS::DBCluster', { EnableIAMDatabaseAuthentication: true });
    data.resourceCountIs('AWS::SecretsManager::RotationSchedule', 1);
    data.hasResourceProperties('AWS::SecretsManager::RotationSchedule', {
      RotationRules: Match.objectLike({ ScheduleExpression: Match.stringLikeRegexp('30') }),
    });
    // Off by context, for a stage that must not run the rotation Lambda.
    synth({ dbRotationDays: 0 }).data.resourceCountIs('AWS::SecretsManager::RotationSchedule', 0);
  });

  it('the RDS CA bundle is downloaded into every DB function bundle, and a bad download fails the build', () => {
    const cmds = rdsCaBundleCommands('/out');
    expect(cmds[0]).toContain('https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem');
    expect(cmds[0]).toContain('-o /out/rds-global-bundle.pem');
    expect(cmds[0]).toMatch(/curl -fsSL/); // -f: HTTP errors fail instead of saving an error page
    expect(cmds[1]).toContain('BEGIN CERTIFICATE');
    expect(cmds[1]).toMatch(/-ge 3/); // a truncated / HTML download is not a bundle
  });

  it('first-master exists only with enableFirstMaster=true, with its own one-table role', () => {
    expect(Object.keys(api.findResources('AWS::Lambda::Function')).length).toBe(FUNCTIONS.length);
    const on = synth({ enableFirstMaster: true }).api;
    const fns = Object.values(on.findResources('AWS::Lambda::Function'));
    const fm = fns.find((f) => f.Properties.FunctionName === 'rd-dev-first-master');
    expect(fm, 'first-master function').toBeDefined();
    expect(fm!.Properties.Environment.Variables.DB_IAM_USER).toBe('rd_first_master');
    expect(fm!.Properties.Environment.Variables.DB_SECRET_ARN).toBeUndefined();
    const stmts = roleStatements(on, 'rd-dev-first-master');
    expect(actionsOf(stmts).filter((a) => a.startsWith('secretsmanager:'))).toEqual([]);
    expect(actionsOf(stmts).filter((a) => a.startsWith('kms:'))).toEqual([]);
    expect(on.toJSON().Outputs).toHaveProperty('FirstMasterFunctionName');
    // And no HTTP route ever reaches it.
    const routes = Object.values(on.findResources('AWS::ApiGatewayV2::Route')).map(
      (r) => r.Properties.RouteKey,
    );
    expect(JSON.stringify(routes)).not.toContain('first-master');
  });

  it('webhook-ttl and history-rebuild read no secrets and no KMS, only their own db role', () => {
    for (const fn of ['webhook-ttl', 'history-rebuild'] as const) {
      const a = actionsOf(roleStatements(api, `rd-dev-${fn}`));
      expect(
        a.filter((x) => /^(secretsmanager|kms):/.test(x)),
        fn,
      ).toEqual([]);
      expect(a).toContain('rds-db:connect');
    }
  });

  it('logs are scoped to each function’s own log group', () => {
    for (const fn of FUNCTIONS) {
      const logStmt = roleStatements(api, `rd-dev-${fn}`).find((s) =>
        asArray(s.Action).includes('logs:PutLogEvents'),
      );
      expect(JSON.stringify(logStmt?.Resource)).toContain('Logs'); // ref to its own LogGroup, not "*"
    }
  });

  it('only the Strava webhook may invoke a Lambda, and only the replay function', () => {
    for (const fn of FUNCTIONS) {
      const invoke = roleStatements(api, `rd-dev-${fn}`).filter((s) =>
        asArray(s.Action).includes('lambda:InvokeFunction'),
      );
      if (fn === 'webhook-strava') {
        expect(invoke).toHaveLength(1);
        expect(JSON.stringify(invoke[0]!.Resource)).toContain('StravaReplay');
        expect(fnProps(fn).Environment.Variables.STRAVA_REPLAY_FUNCTION).toBeDefined();
      } else {
        expect(invoke, fn).toHaveLength(0);
      }
    }
  });

  it('scheduler roles can invoke exactly one function each', () => {
    const roles = api.findResources('AWS::IAM::Role', {
      Properties: {
        AssumeRolePolicyDocument: {
          Statement: [{ Principal: { Service: 'scheduler.amazonaws.com' } }],
        },
      },
    });
    expect(Object.keys(roles)).toHaveLength(5);
  });
});

describe('HTTP API', () => {
  it('has throttling on the stage and structured access logs', () => {
    api.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: '$default',
      AutoDeploy: true,
      DefaultRouteSettings: { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 },
      AccessLogSettings: Match.objectLike({ Format: Match.stringLikeRegexp('routeKey') }),
    });
  });

  it('throttles the unauthenticated Strava POST harder than the stage default (M4)', () => {
    api.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      RouteSettings: {
        'POST /api/v1/webhooks/strava': { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
      },
    });
    const routes = Object.values(api.findResources('AWS::ApiGatewayV2::Route')).map(
      (r) => r.Properties.RouteKey,
    );
    expect(routes).toContain('POST /api/v1/webhooks/strava'); // the key must exist or deploy fails
  });

  it('access logs never include query strings (Strava verify token) or client IPs', () => {
    const stage = Object.values(api.findResources('AWS::ApiGatewayV2::Stage'))[0]!;
    const fmt = JSON.stringify(stage.Properties.AccessLogSettings.Format);
    expect(fmt).not.toMatch(/queryString|rawQueryString|sourceIp|userAgent/i);
  });

  it('routes each webhook to its own function and everything else to the API', () => {
    const routes = Object.values(api.findResources('AWS::ApiGatewayV2::Route')).map(
      (r) => r.Properties.RouteKey,
    );
    expect(routes).toEqual(
      expect.arrayContaining([
        '$default',
        'GET /api/v1/webhooks/terra',
        'POST /api/v1/webhooks/terra',
        'GET /api/v1/webhooks/strava',
        'POST /api/v1/webhooks/strava',
        'GET /api/v1/webhooks/oura',
        'POST /api/v1/webhooks/oura',
      ]),
    );
    expect(routes).toHaveLength(7);
  });

  it('publishes webhook URLs as outputs and the API URL to SSM for the Amplify build', () => {
    for (const o of [
      'ApiUrl',
      'TerraWebhookUrl',
      'StravaWebhookUrl',
      'OuraWebhookUrl',
      'MigrateFunctionName',
    ]) {
      expect(api.toJSON().Outputs).toHaveProperty(o);
    }
    api.hasResourceProperties('AWS::SSM::Parameter', { Name: '/rd/dev/api-url', Type: 'String' });
  });
});

describe('schedules', () => {
  const schedules = () =>
    Object.values(api.findResources('AWS::Scheduler::Schedule')).map((s) => ({
      name: s.Properties.Name as string,
      expr: s.Properties.ScheduleExpression as string,
    }));

  it('are daily/slow by default so Aurora can pause', () => {
    expect(schedules().sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'rd-dev-history-rebuild', expr: 'cron(20 10 * * ? *)' },
      { name: 'rd-dev-oura-subscriptions', expr: 'cron(30 9 * * ? *)' },
      { name: 'rd-dev-oura-sync', expr: 'cron(0 10 * * ? *)' },
      { name: 'rd-dev-strava-replay', expr: 'rate(6 hours)' },
      { name: 'rd-dev-webhook-ttl', expr: 'cron(5 10 * * ? *)' },
    ]);
  });

  it('every schedule is a context value; "off" removes it', () => {
    const t = synth({
      ouraSyncSchedule: 'rate(12 hours)',
      stravaReplaySchedule: 'rate(5 minutes)',
      webhookTtlSchedule: 'off',
    }).api;
    const got = Object.values(t.findResources('AWS::Scheduler::Schedule')).map(
      (s) => s.Properties.ScheduleExpression,
    );
    expect(got).toContain('rate(12 hours)');
    expect(got).toContain('rate(5 minutes)');
    t.resourceCountIs('AWS::Scheduler::Schedule', 4);
  });
});
