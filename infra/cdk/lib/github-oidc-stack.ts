import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import type { InfraConfig } from './config';

export interface GithubOidcStackProps extends StackProps {
  config: InfraConfig;
}

const STAGES = ['dev', 'prod'] as const;

/**
 * One-time, account-level stack (deployed by hand BEFORE the deploy workflow can run): lets the
 * `deploy.yml` workflow authenticate with GitHub OIDC — no long-lived AWS keys anywhere. There is one
 * role per GitHub *environment* (`dev`, `prod`); the trust policy pins the exact repository and the
 * environment, so a branch or fork cannot assume it, and the `prod` environment's required
 * reviewers gate the job before a token is even issued.
 *
 * The role itself can do almost nothing: it may assume the CDK bootstrap roles (which do the real
 * CloudFormation work), read stack outputs, and invoke the migrate / subscription Lambdas.
 */
export class GithubOidcStack extends Stack {
  readonly roles: Record<string, iam.Role> = {};

  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, props);
    const { config } = props;
    const repo = config.github.repo;
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      throw new Error('context "githubRepo" (owner/repo) is required for the OIDC stack');
    }

    const providerArn =
      config.github.existingProviderArn ??
      new iam.OpenIdConnectProvider(this, 'GithubProvider', {
        url: 'https://token.actions.githubusercontent.com',
        clientIds: ['sts.amazonaws.com'],
      }).openIdConnectProviderArn;

    const q = config.bootstrapQualifier;
    for (const stage of STAGES) {
      const role = new iam.Role(this, `Deploy${stage}`, {
        description: `GitHub Actions (environment ${stage}) deploy role for ${repo}`,
        maxSessionDuration: Duration.hours(1),
        assumedBy: new iam.WebIdentityPrincipal(providerArn, {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub': `repo:${repo}:environment:${stage}`,
          },
        }),
      });
      role.addToPolicy(
        new iam.PolicyStatement({
          sid: 'AssumeCdkBootstrapRoles',
          actions: ['sts:AssumeRole'],
          resources: ['deploy', 'file-publishing', 'image-publishing', 'lookup'].map(
            (r) => `arn:${this.partition}:iam::${this.account}:role/cdk-${q}-${r}-role-*`,
          ),
        }),
      );
      role.addToPolicy(
        new iam.PolicyStatement({
          sid: 'ReadStackOutputs',
          actions: ['cloudformation:DescribeStacks'],
          resources: [
            `arn:${this.partition}:cloudformation:${this.region}:${this.account}:stack/rd-${stage}-*/*`,
          ],
        }),
      );
      role.addToPolicy(
        new iam.PolicyStatement({
          sid: 'RunPostDeployLambdas',
          actions: ['lambda:InvokeFunction'],
          resources: ['migrate', 'oura-subscriptions'].map(
            (f) =>
              `arn:${this.partition}:lambda:${this.region}:${this.account}:function:rd-${stage}-${f}`,
          ),
        }),
      );
      this.roles[stage] = role;
    }
  }
}
