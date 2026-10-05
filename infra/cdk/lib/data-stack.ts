import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  SecretValue,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import type { InfraConfig } from './config';
import { PLACEHOLDER } from './constants';

export interface DataStackProps extends StackProps {
  config: InfraConfig;
}

/** Secrets the app reads at cold start (apps/api/src/lambda/bootstrap.ts maps JSON keys -> env vars). */
export interface AppSecrets {
  db: secretsmanager.ISecret;
  /** {NEXTAUTH_SECRET} — shared by the web app (mints HS256 API tokens) and the API (verifies them). */
  nextauth: secretsmanager.ISecret;
  /** {KMS_ENCRYPTED_DATA_KEY} — envelope data key, KMS-encrypted (not secret on its own). */
  tokenKey: secretsmanager.ISecret;
  oura: secretsmanager.ISecret;
  strava: secretsmanager.ISecret;
  terra: secretsmanager.ISecret;
  /** GitHub token Amplify uses to pull the repo. */
  githubToken: secretsmanager.ISecret;
}

/**
 * Network + data (PLAN §11): VPC, Aurora Serverless v2 (Postgres), the token KMS key and every
 * Secrets Manager entry. Secrets are created as placeholders (or generated); humans fill the rest —
 * see DEPLOY.md. Nothing secret is ever in code or in a Lambda env var.
 */
export class DataStack extends Stack {
  readonly vpc: ec2.Vpc;
  readonly lambdaSg: ec2.SecurityGroup;
  readonly dbSg: ec2.SecurityGroup;
  readonly cluster: rds.DatabaseCluster;
  readonly tokenKey: kms.Key;
  readonly secrets: AppSecrets;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { config } = props;
    const removal = config.isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    // ---- Network ---------------------------------------------------------------------------
    // Lambdas live in the VPC to reach Aurora and still call Oura/Strava/Terra, so private subnets
    // need egress. A managed NAT Gateway is a fixed ~monthly baseline, so the default is a small NAT
    // instance (natMode=instance); natMode=gateway trades cost for availability. No interface VPC
    // endpoints: they bill per hour per AZ, which defeats the near-$0 goal. See README.md.
    // The instance sits in a public subnet with a public IP, so its security group must NOT take the
    // CDK default (all traffic from anywhere): `NONE` plus an explicit 80/443-from-Lambdas rule below.
    const natInstances =
      config.natMode === 'instance'
        ? ec2.NatProvider.instanceV2({
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
            defaultAllowedTraffic: ec2.NatTrafficDirection.NONE,
            // T4g defaults to "unlimited" credits, which can bill extra under sustained load.
            creditSpecification: ec2.CpuCredits.STANDARD,
          })
        : undefined;
    const natProvider = natInstances ?? ec2.NatProvider.gateway();

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2, // Aurora's subnet group needs two AZs; only ONE NAT is deployed (cost).
      natGateways: 1,
      natGatewayProvider: natProvider,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 28 },
        { name: 'app', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'db', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    this.lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc: this.vpc,
      description: 'VPC-attached Lambdas (egress to Aurora, NAT)',
      allowAllOutbound: true,
    });
    if (natInstances) {
      // Providers (Oura/Strava/Terra), Secrets Manager, KMS and Lambda APIs are all HTTPS.
      natInstances.connections.allowFrom(this.lambdaSg, ec2.Port.tcp(443), 'Lambda HTTPS egress');
      natInstances.connections.allowFrom(this.lambdaSg, ec2.Port.tcp(80), 'Lambda HTTP egress');
    }
    this.dbSg = new ec2.SecurityGroup(this, 'DbSg', {
      vpc: this.vpc,
      description: 'Aurora: Postgres from the Lambda security group only',
      allowAllOutbound: false,
    });
    this.dbSg.addIngressRule(this.lambdaSg, ec2.Port.tcp(5432), 'Lambdas -> Postgres');

    // ---- KMS: token envelope key ---------------------------------------------------------------
    // Protects the one data key that encrypts OAuth tokens at rest (PLAN §12). Roles get kms:Decrypt
    // only (see ApiStack); the data key is generated once by a human (DEPLOY.md).
    this.tokenKey = new kms.Key(this, 'TokenKey', {
      alias: `alias/${config.prefix}-tokens`,
      description: `Readiness dashboard (${config.stage}) OAuth token data-key protection`,
      enableKeyRotation: true,
      removalPolicy: removal,
      pendingWindow: Duration.days(config.isProd ? 30 : 7),
    });

    // ---- Aurora Serverless v2 ----------------------------------------------------------------
    // Min capacity 0 + auto-pause needs Aurora PostgreSQL >= 16.3 / 15.7 / 14.12 / 13.15.
    // https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html
    // The first connection after a pause resumes the instance (~15 s, 30 s+ after >24 h idle).
    // Acceptable: webhook events are persisted by the (60 s timeout) webhook Lambdas and replayed.
    // Do NOT add RDS Proxy: its open connections prevent auto-pause.
    this.cluster = new rds.DatabaseCluster(this, 'Aurora', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_8,
      }),
      credentials: rds.Credentials.fromGeneratedSecret('rd_admin', {
        secretName: `${config.secretPrefix}/db`,
      }),
      defaultDatabaseName: 'readiness',
      writer: rds.ClusterInstance.serverlessV2('writer', { publiclyAccessible: false }),
      serverlessV2MinCapacity: config.db.minAcu,
      serverlessV2MaxCapacity: config.db.maxAcu,
      ...(config.db.minAcu === 0
        ? { serverlessV2AutoPauseDuration: Duration.minutes(config.db.autoPauseMinutes) }
        : {}),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.dbSg],
      storageEncrypted: true,
      backup: { retention: Duration.days(config.db.backupDays) },
      deletionProtection: config.isProd,
      removalPolicy: config.isProd ? RemovalPolicy.SNAPSHOT : RemovalPolicy.DESTROY,
    });

    // ---- Secrets Manager entries ---------------------------------------------------------------
    const name = (n: string) => `${config.secretPrefix}/${n}`;
    const placeholders = (keys: string[]) =>
      Object.fromEntries(keys.map((k) => [k, SecretValue.unsafePlainText(PLACEHOLDER)]));

    const nextauth = new secretsmanager.Secret(this, 'NextAuthSecret', {
      secretName: name('nextauth'),
      description:
        'NEXTAUTH_SECRET shared by the web app (mints API tokens) and the API (verifies)',
      generateSecretString: {
        secretStringTemplate: '{}',
        generateStringKey: 'NEXTAUTH_SECRET',
        passwordLength: 48,
        excludePunctuation: true,
      },
      removalPolicy: removal,
    });
    const tokenKey = new secretsmanager.Secret(this, 'TokenKeySecret', {
      secretName: name('token-key'),
      description: 'KMS-encrypted token data key. Fill once per stage: see DEPLOY.md step 3',
      secretObjectValue: placeholders(['KMS_ENCRYPTED_DATA_KEY']),
      removalPolicy: removal,
    });
    const oura = new secretsmanager.Secret(this, 'OuraSecret', {
      secretName: name('oura'),
      description: 'Oura OAuth client + webhook verification token (token is generated)',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          OURA_CLIENT_ID: PLACEHOLDER,
          OURA_CLIENT_SECRET: PLACEHOLDER,
        }),
        generateStringKey: 'OURA_WEBHOOK_VERIFICATION_TOKEN',
        passwordLength: 40,
        excludePunctuation: true,
      },
      removalPolicy: removal,
    });
    const strava = new secretsmanager.Secret(this, 'StravaSecret', {
      secretName: name('strava'),
      description:
        'Strava OAuth client + webhook verify token (generated). Add STRAVA_SUBSCRIPTION_ID after registering the webhook',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          STRAVA_CLIENT_ID: PLACEHOLDER,
          STRAVA_CLIENT_SECRET: PLACEHOLDER,
        }),
        generateStringKey: 'STRAVA_WEBHOOK_VERIFY_TOKEN',
        passwordLength: 40,
        excludePunctuation: true,
      },
      removalPolicy: removal,
    });
    const terra = new secretsmanager.Secret(this, 'TerraSecret', {
      secretName: name('terra'),
      description: 'Terra dev id, API key and webhook signing secret (from the Terra dashboard)',
      secretObjectValue: placeholders(['TERRA_DEV_ID', 'TERRA_API_KEY', 'TERRA_SIGNING_SECRET']),
      removalPolicy: removal,
    });
    const githubToken = new secretsmanager.Secret(this, 'GithubTokenSecret', {
      secretName: name('github-token'),
      description: 'GitHub access token Amplify uses to clone the repo (JSON: {"token": "..."})',
      secretObjectValue: placeholders(['token']),
      removalPolicy: removal,
    });

    this.secrets = {
      db: this.cluster.secret!,
      nextauth,
      tokenKey,
      oura,
      strava,
      terra,
      githubToken,
    };

    new CfnOutput(this, 'TokenKeyAlias', { value: `alias/${config.prefix}-tokens` });
    new CfnOutput(this, 'DbEndpoint', { value: this.cluster.clusterEndpoint.hostname });
  }
}
