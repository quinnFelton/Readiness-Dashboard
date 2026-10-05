import { CfnOutput, SecretValue, Stack, type StackProps } from 'aws-cdk-lib';
import * as amplify from 'aws-cdk-lib/aws-amplify';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import type { InfraConfig } from './config';
import type { AppSecrets } from './data-stack';

export interface WebStackProps extends StackProps {
  config: InfraConfig;
  secrets: Pick<AppSecrets, 'nextauth' | 'githubToken'>;
}

/**
 * Amplify Hosting (PLAN §11) for apps/web (Next.js SSR) in the pnpm monorepo.
 *
 * Stack order is data -> web -> api, so the API stack can use this app's URL (OAuth redirects). The
 * web app needs the API URL the other way round; instead of a circular CloudFormation reference the
 * Amplify build reads it from SSM (`/rd/<stage>/api-url`, written by the api stack) and
 * NEXTAUTH_SECRET from Secrets Manager, and writes both to apps/web/.env.production — the documented
 * way to give Next.js SSR env vars on Amplify. Neither value is stored in Amplify's own config.
 * https://docs.aws.amazon.com/amplify/latest/userguide/ssr-environment-variables.html
 */
export class WebStack extends Stack {
  /** Public URL of the web app, no trailing slash. */
  readonly webUrl: string;
  readonly app: amplify.CfnApp;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);
    const { config, secrets } = props;
    const { web } = config;

    // Build-time role: can read ONLY the shared auth secret and the API URL parameter.
    const buildRole = new iam.Role(this, 'BuildRole', {
      assumedBy: new iam.ServicePrincipal('amplify.amazonaws.com'),
      description: `Amplify build (${config.stage}): read NEXTAUTH_SECRET and the API URL`,
    });
    secrets.nextauth.grantRead(buildRole);
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

    this.app = new amplify.CfnApp(this, 'App', {
      name: `${config.prefix}-web`,
      platform: 'WEB_COMPUTE', // Next.js SSR
      iamServiceRole: buildRole.roleArn,
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
        // ARN / parameter *names* only; the values behind them are fetched during the build.
        { name: 'NEXTAUTH_SECRET_ARN', value: secrets.nextauth.secretArn },
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
    // Pass the URL to the build through the branch env (non-secret).
    branch.environmentVariables = [
      { name: 'NEXTAUTH_URL', value: this.webUrl },
      { name: 'AUTH_URL', value: this.webUrl },
      { name: 'AUTH_TRUST_HOST', value: 'true' },
    ];

    new CfnOutput(this, 'AmplifyAppId', { value: this.app.attrAppId });
    new CfnOutput(this, 'WebUrl', { value: this.webUrl });
    new CfnOutput(this, 'AmplifyBranch', { value: web.branch });
  }
}

/**
 * Monorepo build settings (appRoot = apps/web). pnpm is not in the Amplify image and the
 * `hoisted` node linker is required for pnpm workspaces on Amplify:
 * https://docs.aws.amazon.com/amplify/latest/userguide/monorepo-configuration.html
 * SSR env vars must be written to `<appRoot>/.env.production` during the build.
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
    '              NEXTAUTH_SECRET="$(aws secretsmanager get-secret-value --secret-id "$NEXTAUTH_SECRET_ARN" --query SecretString --output text | node -e \'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).NEXTAUTH_SECRET)\')"',
    '              API_URL="$(aws ssm get-parameter --name "$API_URL_PARAM" --query Parameter.Value --output text)"',
    '              {',
    '                printf "NEXTAUTH_SECRET=%s\\n" "$NEXTAUTH_SECRET"',
    '                printf "API_URL=%s\\n" "$API_URL"',
    '                printf "NEXTAUTH_URL=%s\\n" "$NEXTAUTH_URL"',
    '                printf "AUTH_URL=%s\\n" "$AUTH_URL"',
    '                printf "AUTH_TRUST_HOST=true\\n"',
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
