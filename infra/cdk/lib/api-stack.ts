import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import type { InfraConfig } from './config';
import { TOKEN_DATA_KEY_PURPOSE } from './constants';
import type { DataStack } from './data-stack';

export interface ApiStackProps extends StackProps {
  config: InfraConfig;
  data: DataStack;
  /** Public URL of the web app (no trailing slash): OAuth redirect targets. */
  webUrl: string;
}

const repoPath = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const lambdaEntry = (name: string) => repoPath(`apps/api/src/lambda/${name}.ts`);

type SecretKey = 'db' | 'nextauth' | 'tokenKey' | 'oura' | 'strava' | 'terra';

interface FnSpec {
  /** Construct id and function-name suffix. */
  id: string;
  entry: string;
  description: string;
  /** In the VPC (needs Aurora). Only oura-subscriptions is outside: it never touches the DB. */
  vpc: boolean;
  timeout: Duration;
  memoryMb: number;
  /** Secrets this function's role may read (and that are loaded into its env at cold start). */
  secrets: SecretKey[];
  /** kms:Decrypt on the token data key (token encryption/decryption). */
  tokenKms: boolean;
  env?: Record<string, string>;
  /** Copy SQL migrations next to the bundle (migrate only). */
  bundleMigrations?: boolean;
}

/**
 * HTTP API + Lambdas + EventBridge Scheduler (PLAN §11). Every Lambda gets its OWN role containing
 * exactly: scoped log writes, the secrets it reads, kms:Decrypt on the token key if it handles
 * tokens, and (VPC functions) the ENI actions Lambda requires. Database access is network-level
 * (security group) plus the DB secret; there is no IAM database auth.
 *
 *   function              secrets read                          kms:Decrypt  VPC  invoked by
 *   api                   db nextauth token-key oura strava terra   yes       yes  HTTP API (catch-all)
 *   webhook-terra         db terra token-key                    yes          yes  HTTP API /webhooks/terra
 *   webhook-strava        db strava token-key (+invoke replay)  yes          yes  HTTP API /webhooks/strava
 *   webhook-oura          db oura token-key                     yes          yes  HTTP API /webhooks/oura
 *   oura-sync             db oura token-key                     yes          yes  Scheduler (daily)
 *   oura-subscriptions    oura                                  no           no   Scheduler (daily)
 *   strava-replay         db strava token-key                   yes          yes  webhook kick + Scheduler (fallback)
 *   webhook-ttl           db                                    no           yes  Scheduler (daily)
 *   migrate               db                                    no           yes  deploy workflow (aws lambda invoke)
 *
 * PLAN §11 says webhook Lambdas are "RDS write only"; Terra/Strava/Oura ingest also decrypts stored
 * tokens (Strava refresh, Terra backfill) and holds that provider's client secret, so those two
 * grants are added — and nothing else. See README.md.
 */
export class ApiStack extends Stack {
  readonly httpApi: apigwv2.HttpApi;
  readonly functions: Record<string, lambda.Function> = {};
  readonly accessLogGroup: logs.LogGroup;

  private readonly cfg: InfraConfig;
  private readonly data: DataStack;
  private readonly sharedEnv: Record<string, string>;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    this.cfg = props.config;
    this.data = props.data;
    const { config, webUrl } = props;

    // Non-secret config shared by every function; secrets arrive via Secrets Manager at cold start.
    this.sharedEnv = {
      NODE_ENV: 'production',
      PG_POOL_MAX: '1', // one connection per Lambda container: Aurora is small and may auto-pause
      STAGE: config.stage,
      APP_URL: webUrl,
      OURA_USE_SANDBOX: String(config.ouraSandbox),
      OURA_REDIRECT_URI: `${webUrl}/settings/connections/oura/callback`,
      STRAVA_REDIRECT_URI: `${webUrl}/settings/connections/strava/callback`,
      TERRA_SUCCESS_REDIRECT_URL: `${webUrl}/settings`,
      TERRA_FAILURE_REDIRECT_URL: `${webUrl}/settings`,
    };

    // ---- Functions that don't depend on the API URL --------------------------------------------
    const api = this.fn({
      id: 'api',
      entry: lambdaEntry('api'),
      description: 'REST API (Express via serverless-http)',
      vpc: true,
      timeout: Duration.seconds(28), // HTTP API's integration limit is 30 s
      memoryMb: 512,
      secrets: ['db', 'nextauth', 'tokenKey', 'oura', 'strava', 'terra'],
      tokenKms: true,
    });

    // Webhook Lambdas persist the event first. After an Aurora auto-pause the first insert waits for
    // the resume (~15 s, 30 s+ after a day idle); 60 s outlives API Gateway's 30 s so the row is still
    // written and replayed even if the provider already timed out and retries.
    const webhookBase = { vpc: true, timeout: Duration.seconds(60), memoryMb: 512, tokenKms: true };
    const replay = this.fn({
      id: 'strava-replay',
      entry: lambdaEntry('strava-replay'),
      description: 'Completes pending/failed Strava webhook events (PLAN §13)',
      vpc: true,
      timeout: Duration.minutes(5),
      memoryMb: 512,
      secrets: ['db', 'strava', 'tokenKey'],
      tokenKms: true,
    });
    const terraHook = this.fn({
      ...webhookBase,
      id: 'webhook-terra',
      entry: lambdaEntry('webhooks'),
      description: 'Terra webhook receiver (signature-verified)',
      secrets: ['db', 'terra', 'tokenKey'],
      env: { WEBHOOK_PROVIDERS: 'terra' },
    });
    const stravaHook = this.fn({
      ...webhookBase,
      id: 'webhook-strava',
      entry: lambdaEntry('webhooks'),
      description: 'Strava webhook receiver (verify token + pinned subscription id)',
      secrets: ['db', 'strava', 'tokenKey'],
      env: { WEBHOOK_PROVIDERS: 'strava', STRAVA_REPLAY_FUNCTION: replay.functionName },
    });
    replay.grantInvoke(this.roleOf(stravaHook)); // kick the replay after answering; this ONE function
    const ouraHook = this.fn({
      ...webhookBase,
      id: 'webhook-oura',
      entry: lambdaEntry('webhooks'),
      description: 'Oura webhook receiver (HMAC-verified)',
      secrets: ['db', 'oura', 'tokenKey'],
      env: { WEBHOOK_PROVIDERS: 'oura' },
    });
    const ouraSync = this.fn({
      id: 'oura-sync',
      entry: lambdaEntry('oura-sync'),
      description: 'Daily Oura incremental sync (safety net behind Oura webhooks)',
      vpc: true,
      timeout: Duration.minutes(10),
      memoryMb: 512,
      secrets: ['db', 'oura', 'tokenKey'],
      tokenKms: true,
    });
    const ttl = this.fn({
      id: 'webhook-ttl',
      entry: lambdaEntry('webhook-ttl'),
      description: 'Deletes webhook_events older than WEBHOOK_TTL_DAYS (PLAN §13)',
      vpc: true,
      timeout: Duration.minutes(2),
      memoryMb: 256,
      secrets: ['db'],
      tokenKms: false,
      env: { WEBHOOK_TTL_DAYS: String(config.webhookTtlDays) },
    });
    const migrate = this.fn({
      id: 'migrate',
      entry: lambdaEntry('migrate'),
      description:
        'Applies apps/api/db/migrations from inside the VPC (invoked by the deploy workflow)',
      vpc: true,
      timeout: Duration.minutes(15),
      memoryMb: 512,
      secrets: ['db'],
      tokenKms: false,
      env: { MIGRATIONS_DIR: '/var/task/migrations' },
      bundleMigrations: true,
    });

    // ---- HTTP API ---------------------------------------------------------------------------------
    this.accessLogGroup = new logs.LogGroup(this, 'AccessLogs', {
      retention: retention(config.logRetentionDays),
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `${config.prefix}-api`,
      description: 'Readiness dashboard REST API + provider webhooks',
      createDefaultStage: false,
      defaultIntegration: new HttpLambdaIntegration('ApiIntegration', api),
    });
    // Throttling is ON for every route (PLAN §12 "rate-limit the public API via API Gateway").
    // Access logs are JSON, carry no query strings (Strava's verify token is a query parameter) and
    // feed the webhook-auth-failure alarm.
    new apigwv2.HttpStage(this, 'DefaultStage', {
      httpApi: this.httpApi,
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: config.throttle.rateLimit, burstLimit: config.throttle.burstLimit },
      accessLogSettings: {
        destination: new apigwv2.LogGroupLogDestination(this.accessLogGroup),
        format: apigw.AccessLogFormat.custom(
          JSON.stringify({
            requestId: '$context.requestId',
            routeKey: '$context.routeKey',
            status: '$context.status',
            method: '$context.httpMethod',
            path: '$context.path',
            latencyMs: '$context.responseLatency',
            integrationStatus: '$context.integrationStatus',
          }),
        ),
      },
    });

    const hook = (provider: string, fn: lambda.IFunction) =>
      this.httpApi.addRoutes({
        path: `/api/v1/webhooks/${provider}`,
        methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
        integration: new HttpLambdaIntegration(`${provider}Integration`, fn),
      });
    hook('terra', terraHook);
    hook('strava', stravaHook);
    hook('oura', ouraHook);

    const apiUrl = this.httpApi.apiEndpoint;
    new ssm.StringParameter(this, 'ApiUrlParam', {
      parameterName: config.apiUrlParam,
      stringValue: apiUrl,
      description: 'API base URL, read by the Amplify build (avoids a web<->api stack cycle)',
    });

    // Needs the API URL (webhook callback), but is not behind the API itself -> no cycle.
    const ouraSubs = this.fn({
      id: 'oura-subscriptions',
      entry: lambdaEntry('oura-subscriptions'),
      description: 'Daily renewal of Oura webhook subscriptions (no DB, outside the VPC)',
      vpc: false,
      timeout: Duration.minutes(2),
      memoryMb: 256,
      secrets: ['oura'],
      tokenKms: false,
      env: { OURA_WEBHOOK_CALLBACK_URL: `${apiUrl}/api/v1/webhooks/oura` },
    });

    // ---- Schedules (EventBridge Scheduler) --------------------------------------------------------
    const { schedules } = config;
    if (schedules.ouraSync) this.schedule('OuraSync', ouraSync, schedules.ouraSync);
    if (schedules.ouraSubscriptions) {
      this.schedule('OuraSubscriptions', ouraSubs, schedules.ouraSubscriptions);
    }
    if (schedules.stravaReplay) this.schedule('StravaReplay', replay, schedules.stravaReplay);
    if (schedules.webhookTtl) this.schedule('WebhookTtl', ttl, schedules.webhookTtl);

    for (const [name, fn] of Object.entries({
      api,
      'webhook-terra': terraHook,
      'webhook-strava': stravaHook,
      'webhook-oura': ouraHook,
      'oura-sync': ouraSync,
      'oura-subscriptions': ouraSubs,
      'strava-replay': replay,
      'webhook-ttl': ttl,
      migrate,
    })) {
      this.functions[name] = fn;
    }

    new CfnOutput(this, 'ApiUrl', { value: apiUrl });
    new CfnOutput(this, 'TerraWebhookUrl', { value: `${apiUrl}/api/v1/webhooks/terra` });
    new CfnOutput(this, 'StravaWebhookUrl', { value: `${apiUrl}/api/v1/webhooks/strava` });
    new CfnOutput(this, 'OuraWebhookUrl', { value: `${apiUrl}/api/v1/webhooks/oura` });
    new CfnOutput(this, 'MigrateFunctionName', { value: migrate.functionName });
    new CfnOutput(this, 'OuraSubscriptionsFunctionName', { value: ouraSubs.functionName });
  }

  private roleOf(fn: lambda.Function): iam.IRole {
    return fn.role!;
  }

  /** One function + one dedicated, scoped role + its own log group. */
  private fn(spec: FnSpec): lambda.Function {
    const config = this.cfg;
    const name = `${config.prefix}-${spec.id}`;
    const secrets = spec.secrets.map((k) => this.data.secrets[k] as secretsmanager.ISecret);

    const logGroup = new logs.LogGroup(this, `${pascal(spec.id)}Logs`, {
      logGroupName: `/aws/lambda/${name}`,
      retention: retention(config.logRetentionDays),
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const role = new iam.Role(this, `${pascal(spec.id)}Role`, {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Least-privilege role for ${name}`,
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [logGroup.logGroupArn, `${logGroup.logGroupArn}:*`],
      }),
    );
    if (spec.vpc) {
      // Required by Lambda to attach ENIs; these EC2 actions do not support resource scoping.
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: [
            'ec2:CreateNetworkInterface',
            'ec2:DescribeNetworkInterfaces',
            'ec2:DeleteNetworkInterface',
          ],
          resources: ['*'],
        }),
      );
    }
    for (const secret of secrets) secret.grantRead(role);
    if (spec.tokenKms) {
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['kms:Decrypt'],
          resources: [this.data.tokenKey.keyArn],
          conditions: {
            StringEquals: { 'kms:EncryptionContext:purpose': TOKEN_DATA_KEY_PURPOSE },
          },
        }),
      );
    }

    const environment: Record<string, string> = {
      ...this.sharedEnv,
      ...spec.env,
      SECRET_ARNS: secrets
        .filter((x) => x !== this.data.secrets.db)
        .map((x) => x.secretArn)
        .join(','),
    };
    if (spec.secrets.includes('db')) environment.DB_SECRET_ARN = this.data.secrets.db.secretArn;
    if (spec.tokenKms) environment.KMS_KEY_ID = this.data.tokenKey.keyId;

    const fn = new nodejs.NodejsFunction(this, pascal(spec.id), {
      functionName: name,
      description: spec.description,
      entry: spec.entry,
      handler: 'handler',
      projectRoot: repoPath(''),
      depsLockFilePath: repoPath('pnpm-lock.yaml'),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: spec.memoryMb,
      timeout: spec.timeout,
      role,
      logGroup,
      environment,
      ...(spec.vpc
        ? {
            vpc: this.data.vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            securityGroups: [this.data.lambdaSg],
          }
        : {}),
      bundling: {
        // Workspace packages (@rd/*) ship TypeScript source; esbuild compiles them into the bundle.
        target: 'node22',
        sourceMap: true,
        externalModules: ['pg-native'], // optional native pg binding, never installed
        commandHooks: spec.bundleMigrations
          ? {
              beforeBundling: () => [],
              beforeInstall: () => [],
              afterBundling: (inputDir: string, outputDir: string) => [
                `cp -R ${inputDir}/apps/api/db/migrations ${outputDir}/migrations`,
              ],
            }
          : undefined,
      },
    });
    return fn;
  }

  /** EventBridge Scheduler -> Lambda, invoked through a role that can invoke only that function. */
  private schedule(id: string, fn: lambda.IFunction, expression: string): void {
    const role = new iam.Role(this, `${id}SchedulerRole`, {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: `Lets EventBridge Scheduler invoke ${fn.functionName} only`,
    });
    fn.grantInvoke(role);
    new scheduler.CfnSchedule(this, `${id}Schedule`, {
      name: `${this.cfg.prefix}-${kebab(id)}`,
      description: `${id} (${expression})`,
      scheduleExpression: expression,
      scheduleExpressionTimezone: 'UTC',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: fn.functionArn,
        roleArn: role.roleArn,
        input: '{}',
        retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 3600 },
      },
    });
  }
}

const pascal = (s: string) =>
  s
    .split('-')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
const kebab = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();

function retention(days: number): logs.RetentionDays {
  const allowed = Object.values(logs.RetentionDays)
    .filter((v): v is number => typeof v === 'number')
    .sort((a, b) => a - b);
  const match = allowed.find((d) => d >= days);
  return (match ?? logs.RetentionDays.INFINITE) as logs.RetentionDays;
}
