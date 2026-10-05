import { CfnOutput, Fn, SecretValue, Stack, type StackProps } from 'aws-cdk-lib';
import * as amplify from 'aws-cdk-lib/aws-amplify';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import type { InfraConfig } from './config';
import type { AppSecrets } from './data-stack';

export interface WebStackProps extends StackProps {
  config: InfraConfig;
  secrets: Pick<AppSecrets, 'nextauth' | 'googleOauth' | 'githubToken'>;
}

/**
 * Amplify Hosting (PLAN §11) for apps/web (Next.js SSR) in the pnpm monorepo.
 *
 * Stack order is data -> web -> api, so the API stack can use this app's URL (OAuth redirects). The
 * web app needs the API URL the other way round; instead of a circular CloudFormation reference the
 * Amplify build reads it from SSM (`/rd/<stage>/api-url`, written by the api stack) and writes it to
 * apps/web/.env.production — the documented way to give Next.js SSR env vars on Amplify:
 * https://docs.aws.amazon.com/amplify/latest/userguide/ssr-environment-variables.html
 *
 * SECRETS ARE NOT IN THE BUILD (stage E item). NEXTAUTH_SECRET and the Google OAuth client used to
 * be written into .env.production, i.e. into build artifacts. Now the build role cannot read any
 * secret, and .env.production holds only non-secret values: the API URL, the stage and the ARNs of the
 * secrets (RUNTIME_SECRET_ARNS). The running app reads those secrets itself, once per server start
 * (apps/web/src/instrumentation.ts -> lib/auth/runtime-secrets.ts) with the SSR *compute role*, which
 * is the only principal that can read them:
 * https://docs.aws.amazon.com/amplify/latest/userguide/amplify-SSR-compute-role.html
 */
export class WebStack extends Stack {
  /** Public URL of the web app, no trailing slash. */
  readonly webUrl: string;
  readonly app: amplify.CfnApp;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);
    const { config, secrets } = props;
    const { web } = config;

    // Build-time role: can read ONLY the API URL parameter. No secret is readable during a build.
    const buildRole = new iam.Role(this, 'BuildRole', {
      assumedBy: new iam.ServicePrincipal('amplify.amazonaws.com'),
      description: `Amplify build (${config.stage}): read the API URL parameter`,
    });
    buildRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          this.formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: config.apiUrlParam.replace(/^\//, ''),
          }),
        ],
      }),
    );

    // Runtime role of the SSR compute (the Next.js server). Its credentials exist only inside the
    // running app. It can read exactly the two secrets the web app needs, nothing else.
    const computeRole = new iam.Role(this, 'ComputeRole', {
      assumedBy: new iam.ServicePrincipal('amplify.amazonaws.com'),
      description: `Amplify SSR compute (${config.stage}): read NEXTAUTH_SECRET and the Google OAuth client`,
    });
    secrets.nextauth.grantRead(computeRole);
    secrets.googleOauth.grantRead(computeRole);

    this.app = new amplify.CfnApp(this, 'App', {
      name: `${config.prefix}-web`,
      platform: 'WEB_COMPUTE', // Next.js SSR
      iamServiceRole: buildRole.roleArn,
      computeRoleArn: computeRole.roleArn,
      ...(web.repository
        ? {
            repository: web.repository,
            // Resolved by CloudFormation at deploy time from Secrets Manager; never in the template.
            accessToken: SecretValue.secretsManager(secrets.githubToken.secretName, {
              jsonField: 'token',
            }).unsafeUnwrap(),
          }
        : {}),
      buildSpec: buildSpec(),
      environmentVariables: [
        { name: 'AMPLIFY_MONOREPO_APP_ROOT', value: 'apps/web' },
        { name: 'AMPLIFY_DIFF_DEPLOY', value: 'false' },
        { name: 'STAGE', value: config.stage },
        // ARNs / parameter *names* only; the secret values are fetched by the running app.
        {
          name: 'RUNTIME_SECRET_ARNS',
          value: Fn.join(',', [secrets.nextauth.secretArn, secrets.googleOauth.secretArn]),
        },
        { name: 'API_URL_PARAM', value: config.apiUrlParam },
      ],
    });

    const branch = new amplify.CfnBranch(this, 'Branch', {
      appId: this.app.attrAppId,
      branchName: web.branch,
      stage: config.isProd ? 'PRODUCTION' : 'DEVELOPMENT',
      framework: 'Next.js - SSR',
      enableAutoBuild: web.autoBuild,
      enablePullRequestPreview: false,
    });

    this.webUrl = web.domain
      ? `https://${web.domain}`
      : `https://${web.branch}.${this.app.attrDefaultDomain}`;
    // Pass the URL to the build through the branch env (non-secret). AUTH_TRUST_HOST is deliberately
    // absent (security review L9): Auth.js trusts the host when AUTH_URL is set, and AUTH_URL always
    // is, so the forwarded-host header is never what decides the origin.
    branch.environmentVariables = [
      { name: 'NEXTAUTH_URL', value: this.webUrl },
      { name: 'AUTH_URL', value: this.webUrl },
    ];

    new CfnOutput(this, 'AmplifyAppId', { value: this.app.attrAppId });
    new CfnOutput(this, 'WebUrl', { value: this.webUrl });
    new CfnOutput(this, 'AmplifyBranch', { value: web.branch });
    new CfnOutput(this, 'ComputeRoleArn', { value: computeRole.roleArn });
  }
}

/**
 * Monorepo build settings (appRoot = apps/web). pnpm is not in the Amplify image and the
 * `hoisted` node linker is required for pnpm workspaces on Amplify:
 * https://docs.aws.amazon.com/amplify/latest/userguide/monorepo-configuration.html
 * SSR env vars must be written to `<appRoot>/.env.production` during the build. Only NON-SECRET
 * values go there (see the class comment): never add a secret value to this file.
 */
export function buildSpec(): string {
  const lines = [
    'version: 1',
    'applications:',
    '  - appRoot: apps/web',
    '    frontend:',
    '      buildPath: /',
    '      phases:',
    '        preBuild:',
    '          commands:',
    '            - nvm install 24 && nvm use 24',
    '            - npm install -g pnpm@10',
    '            - echo "node-linker=hoisted" >> .npmrc',
    '            - pnpm install --frozen-lockfile',
    '        build:',
    '          commands:',
    '            - |',
    '              API_URL="$(aws ssm get-parameter --name "$API_URL_PARAM" --query Parameter.Value --output text)"',
    '              {',
    '                printf "API_URL=%s\\n" "$API_URL"',
    '                printf "STAGE=%s\\n" "$STAGE"',
    '                printf "RUNTIME_SECRET_ARNS=%s\\n" "$RUNTIME_SECRET_ARNS"',
    '                printf "NEXTAUTH_URL=%s\\n" "$NEXTAUTH_URL"',
    '                printf "AUTH_URL=%s\\n" "$AUTH_URL"',
    '              } >> apps/web/.env.production',
    '            - pnpm --filter @rd/web build',
    '      artifacts:',
    '        baseDirectory: apps/web/.next',
    '        files:',
    "          - '**/*'",
    '      cache:',
    '        paths:',
    '          - node_modules/**/*',
    '          - apps/web/.next/cache/**/*',
  ];
  return lines.join('\n') + '\n';
}
