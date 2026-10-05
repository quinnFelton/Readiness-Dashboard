import { type App, Tags } from 'aws-cdk-lib';
import { ApiStack } from './api-stack';
import { type InfraConfig, loadConfig } from './config';
import { DataStack } from './data-stack';
import { GithubOidcStack } from './github-oidc-stack';
import { ObservabilityStack } from './observability-stack';
import { WebStack } from './web-stack';

export interface Stacks {
  config: InfraConfig;
  data: DataStack;
  web: WebStack;
  api: ApiStack;
  observability: ObservabilityStack;
  githubOidc?: GithubOidcStack;
}

/**
 * Deploy order: data -> web -> api -> observability (each depends on the previous through real
 * references). The Amplify build reads the API URL from SSM at build time instead of a reference,
 * which is what keeps web and api from depending on each other.
 */
export function buildStacks(app: App): Stacks {
  const config = loadConfig(app.node);
  // Account and region come from the credentials the CLI runs with — never from code.
  const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };
  const common = { env, terminationProtection: config.isProd };

  const data = new DataStack(app, `${config.prefix}-data`, { ...common, config });
  const web = new WebStack(app, `${config.prefix}-web`, {
    ...common,
    config,
    secrets: data.secrets,
  });
  const api = new ApiStack(app, `${config.prefix}-api`, {
    ...common,
    config,
    data,
    webUrl: web.webUrl,
  });
  const observability = new ObservabilityStack(app, `${config.prefix}-observability`, {
    ...common,
    config,
    api,
  });

  // Account-level, deployed once by hand (DEPLOY.md). Only exists when `-c githubRepo=owner/repo`.
  const githubOidc = config.github.repo
    ? new GithubOidcStack(app, 'rd-github-oidc', { env, config })
    : undefined;

  Tags.of(app).add('app', 'readiness-dashboard');
  Tags.of(app).add('stage', config.stage);
  return { config, data, web, api, observability, githubOidc };
}
