import serverless from 'serverless-http';
import { createApp } from '../app';
import { ensureBootstrapped } from './bootstrap';

// REST API Lambda (PLAN §11). Secrets (DATABASE_URL, NEXTAUTH_SECRET, provider client secrets) are
// loaded from Secrets Manager once per cold start, before the Express app or pool exist.
// NOTE: createApp() also mounts the webhook routers; API Gateway does not route webhook paths to this
// function (they go to the per-provider webhook Lambdas), so they are unreachable here. A
// `createApp({ webhooks: false })` option would remove them entirely (see infra README "Needs").

type Handler = ReturnType<typeof serverless>;
let inner: Handler | undefined;

export const handler: Handler = async (event, context) => {
  await ensureBootstrapped();
  inner ??= serverless(createApp());
  return inner(event, context);
};
