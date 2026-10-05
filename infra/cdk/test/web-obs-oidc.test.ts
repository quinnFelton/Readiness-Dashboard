import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { buildSpec } from '../lib/web-stack';
import { asArray, synth } from './helpers';

describe('web stack (Amplify)', () => {
  const { web } = synth({ webRepository: 'https://github.com/owner/repo' });

  it('hosts the Next.js SSR app from the monorepo with the hoisted pnpm linker', () => {
    web.hasResourceProperties('AWS::Amplify::App', {
      Platform: 'WEB_COMPUTE',
      Repository: 'https://github.com/owner/repo',
      EnvironmentVariables: Match.arrayWith([
        { Name: 'AMPLIFY_MONOREPO_APP_ROOT', Value: 'apps/web' },
      ]),
      BuildSpec: Match.stringLikeRegexp('appRoot: apps/web'),
    });
    web.hasResourceProperties('AWS::Amplify::Branch', {
      Framework: 'Next.js - SSR',
      EnableAutoBuild: false,
    });
    const spec = buildSpec();
    expect(spec).toContain('node-linker=hoisted');
    expect(spec).toContain('npm install -g pnpm');
    expect(spec).toContain('apps/web/.env.production'); // SSR env must be written under the app root
    expect(spec).toContain('baseDirectory: apps/web/.next');
    expect(spec).toContain('pnpm --filter @rd/web build');
  });

  it('reads NEXTAUTH_SECRET from the SAME Secrets Manager entry the API reads', () => {
    expect(buildSpec()).toContain(
      'secretsmanager get-secret-value --secret-id "$NEXTAUTH_SECRET_ARN"',
    );
    const { api, data } = synth();
    const nextauth = Object.entries(data.findResources('AWS::SecretsManager::Secret')).find(
      ([, s]) => s.Properties.Name === 'rd/dev/nextauth',
    );
    expect(nextauth).toBeDefined();
    // The API's SECRET_ARNS include a cross-stack import of that very secret.
    const env = Object.values(api.findResources('AWS::Lambda::Function')).find(
      (f) => f.Properties.FunctionName === 'rd-dev-api',
    )!.Properties.Environment.Variables.SECRET_ARNS;
    expect(JSON.stringify(env)).toContain('NextAuthSecret');
    expect(JSON.stringify(web.findResources('AWS::Amplify::App'))).toContain('NextAuthSecret');
  });

  it('keeps secret values out of Amplify config; only ARNs/names and the GitHub token reference', () => {
    const json = JSON.stringify(web.toJSON());
    expect(json).not.toMatch(/REPLACE_ME|NEXTAUTH_SECRET=[A-Za-z0-9]/);
    // Repo access token is a CloudFormation dynamic reference, resolved at deploy time.
    expect(json).toContain('{{resolve:secretsmanager:');
    expect(json).toContain(':SecretString:token::}}');
  });

  it('build role may read only the auth secret and the api-url parameter', () => {
    const policies = Object.values(web.findResources('AWS::IAM::Policy'));
    const actions = policies.flatMap((p) =>
      p.Properties.PolicyDocument.Statement.flatMap((s: { Action: string | string[] }) =>
        asArray(s.Action),
      ),
    );
    expect(actions.sort()).toEqual([
      'secretsmanager:DescribeSecret',
      'secretsmanager:GetSecretValue',
      'ssm:GetParameter',
    ]);
    expect(JSON.stringify(policies)).toContain('parameter/rd/dev/api-url');
  });

  it('computes NEXTAUTH_URL from the Amplify default domain unless a custom domain is configured', () => {
    // https://<branch>.<app default domain, e.g. d123.amplifyapp.com>
    const urlOutput = JSON.stringify(web.toJSON().Outputs.WebUrl);
    expect(urlOutput).toContain('https://dev.');
    expect(urlOutput).toContain('DefaultDomain');
    const custom = synth({ webDomain: 'app.example.com' });
    expect(custom.stacks.web.webUrl).toBe('https://app.example.com');
    expect(JSON.stringify(custom.api.toJSON())).toContain(
      'https://app.example.com/settings/connections/oura/callback',
    );
  });

  it('can be created without a repository (manual deployments)', () => {
    synth().web.hasResourceProperties('AWS::Amplify::App', { Repository: Match.absent() });
  });
});

describe('observability stack', () => {
  it('emails the context alarmEmail through SNS', () => {
    const { observability } = synth({ alarmEmail: 'oncall@example.com' });
    observability.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'oncall@example.com',
    });
    const alarms = Object.values(observability.findResources('AWS::CloudWatch::Alarm'));
    expect(alarms).toHaveLength(6); // within the CloudWatch free tier of 10
    for (const a of alarms) expect(a.Properties.AlarmActions).toHaveLength(1);
  });

  it('creates the topic without a subscription when no email is given (no hardcoded address)', () => {
    const { observability } = synth();
    observability.resourceCountIs('AWS::SNS::Topic', 1);
    observability.resourceCountIs('AWS::SNS::Subscription', 0);
  });

  it('alarms on the PLAN §11 conditions: sync failures and webhook signature failures', () => {
    const { observability } = synth();
    observability.hasResourceProperties('AWS::Logs::MetricFilter', {
      FilterPattern: '"oura_sync_failures"',
      MetricTransformations: [Match.objectLike({ MetricName: 'OuraSyncFailures' })],
    });
    observability.hasResourceProperties('AWS::Logs::MetricFilter', {
      FilterPattern: Match.stringLikeRegexp('webhooks.*401.*403'),
      MetricTransformations: [Match.objectLike({ MetricName: 'WebhookAuthFailures' })],
    });
    observability.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'rd-dev-oura-sync-failures',
    });
    observability.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'rd-dev-webhook-auth-failures',
    });
  });
});

describe('GitHub OIDC stack', () => {
  it('only exists when githubRepo is provided', () => {
    expect(synth().oidc).toBeUndefined();
  });

  it('trusts exactly one repo + environment per role, with no long-lived keys', () => {
    const { oidc } = synth({ githubRepo: 'owner/repo' });
    oidc!.hasResourceProperties('Custom::AWSCDKOpenIdConnectProvider', {
      Url: 'https://token.actions.githubusercontent.com',
      ClientIDList: ['sts.amazonaws.com'],
    });
    const roles = Object.values(oidc!.findResources('AWS::IAM::Role')).filter((r) =>
      r.Properties.Description?.startsWith('GitHub Actions'),
    );
    expect(roles).toHaveLength(2);
    const subs = roles.map(
      (r) =>
        r.Properties.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals[
          'token.actions.githubusercontent.com:sub'
        ],
    );
    expect(subs.sort()).toEqual([
      'repo:owner/repo:environment:dev',
      'repo:owner/repo:environment:prod',
    ]);
    expect(JSON.stringify(oidc!.toJSON())).not.toMatch(/AWS::IAM::AccessKey|AccessKeyId/);
    // Minimal permissions: assume CDK bootstrap roles, read outputs, invoke two Lambdas.
    const actions = Object.values(oidc!.findResources('AWS::IAM::Policy')).flatMap((p) =>
      p.Properties.PolicyDocument.Statement.flatMap((s: { Action: string | string[] }) =>
        asArray(s.Action),
      ),
    );
    expect([...new Set(actions)].sort()).toEqual([
      'cloudformation:DescribeStacks',
      'lambda:InvokeFunction',
      'sts:AssumeRole',
    ]);
  });

  it('can reuse an existing account-wide OIDC provider', () => {
    const arn = 'arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com';
    const { oidc } = synth({ githubRepo: 'owner/repo', githubOidcProviderArn: arn });
    oidc!.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 0);
  });

  it('rejects a malformed repo', () => {
    expect(() => synth({ githubRepo: 'not a repo' })).toThrow(/githubRepo/);
  });
});

describe('repo hygiene', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = ['bin', 'lib'].flatMap((d) =>
    readdirSync(join(root, d), { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.ts'))
      .map((e) => join(e.parentPath, e.name)),
  );

  it('has no AWS account ids, access keys or secrets in code', () => {
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/\b\d{12}\b/);
      expect(src, f).not.toMatch(/AKIA[0-9A-Z]{16}|aws_secret_access_key|-----BEGIN/i);
    }
  });

  it('keeps the KMS encryption-context constant in sync with apps/api', () => {
    const api = readFileSync(join(root, '../../apps/api/src/crypto/token-cipher.ts'), 'utf8');
    const infra = readFileSync(join(root, 'lib/constants.ts'), 'utf8');
    const apiValue = /purpose: '([^']+)'/.exec(api)?.[1];
    const infraValue = /TOKEN_DATA_KEY_PURPOSE = '([^']+)'/.exec(infra)?.[1];
    expect(apiValue).toBeDefined();
    expect(infraValue).toBe(apiValue);
  });

  it('keeps the sync-failure log marker in sync with apps/api', () => {
    const api = readFileSync(join(root, '../../apps/api/src/lambda/oura-sync.ts'), 'utf8');
    const obs = readFileSync(join(root, 'lib/observability-stack.ts'), 'utf8');
    const apiValue = /SYNC_FAILURE_MARKER = '([^']+)'/.exec(api)?.[1];
    const obsValue = /OURA_SYNC_FAILURE_MARKER = '([^']+)'/.exec(obs)?.[1];
    expect(apiValue).toBeDefined();
    expect(obsValue).toBe(apiValue);
  });
});
