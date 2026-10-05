import serverless from 'serverless-http';
import { createApp } from '../app';
import { ensureBootstrapped } from './bootstrap';

// REST API Lambda (PLAN §11). Secrets (DATABASE_URL, NEXTAUTH_SECRET, provider client secrets) are
// loaded from Secrets Manager once per cold start, before the Express app or pool exist.
// Webhook routers are not mounted here (createApp({ mount: 'api' }), integration stage E): API
// Gateway routes webhook paths to the per-provider webhook Lambdas, whose roles hold those secrets.

type Handler = ReturnType<typeof serverless>;
let inner: Handler | undefined;

export const handler: Handler = async (event, context) => {
  await ensureBootstrapped();
  inner ??= serverless(createApp({ mount: 'api' }));
  return inner(event, context);
};
