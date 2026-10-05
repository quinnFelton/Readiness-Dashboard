import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { type Stacks, buildStacks } from '../lib/app';

export interface Synthed {
  stacks: Stacks;
  data: Template;
  web: Template;
  api: Template;
  observability: Template;
  oidc?: Template;
}

/** Synthesises every stack without running esbuild (bundling is exercised by `cdk synth`). */
export function synth(context: Record<string, unknown> = {}): Synthed {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [], ...context } });
  const stacks = buildStacks(app);
  return {
    stacks,
    data: Template.fromStack(stacks.data),
    web: Template.fromStack(stacks.web),
    api: Template.fromStack(stacks.api),
    observability: Template.fromStack(stacks.observability),
    oidc: stacks.githubOidc ? Template.fromStack(stacks.githubOidc) : undefined,
  };
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface Statement {
  Effect: string;
  Action: string | string[];
  Resource?: unknown;
  Condition?: Json;
}

export const asArray = <T>(v: T | T[] | undefined): T[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

/** Every IAM statement attached (inline policies) to the role whose Description mentions `needle`. */
export function roleStatements(template: Template, needle: string): Statement[] {
  const roles = template.findResources('AWS::IAM::Role', {
    Properties: { Description: `Least-privilege role for ${needle}` },
  });
  const ids = Object.keys(roles);
  if (ids.length !== 1)
    throw new Error(`expected exactly one role for ${needle}, got ${ids.length}`);
  const policies = template.findResources('AWS::IAM::Policy');
  return Object.values(policies)
    .filter((p) => asArray<Json>(p.Properties.Roles).some((r) => r.Ref === ids[0]))
    .flatMap((p) => p.Properties.PolicyDocument.Statement as Statement[]);
}

/** All actions granted to a role, flattened. */
export const actionsOf = (stmts: Statement[]): string[] => stmts.flatMap((s) => asArray(s.Action));

/** Stringified resources, for substring assertions on tokens like {"Ref": "..."}. */
export const resourcesJson = (s: Statement): string => JSON.stringify(s.Resource);
