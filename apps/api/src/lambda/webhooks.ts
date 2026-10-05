import express, { type Express } from 'express';
import serverless from 'serverless-http';
import { createOuraWebhookRouter } from '../providers/oura/webhook';
import { lazyStravaIngest, registerDefaultAdapters } from '../providers/register-all';
import { stravaWebhookRouter } from '../webhooks/strava/routes';
import { terraWebhookRouter } from '../webhooks/terra/router';
import { ensureBootstrapped } from './bootstrap';

// PLAN §11: webhook receivers are separate Lambdas so each role holds only its own provider's
// secrets. One bundle, three deployments: WEBHOOK_PROVIDERS (e.g. "terra") picks which routers this
// function mounts. Paths and mount order mirror app.ts (webhooks BEFORE any global body parser:
// Terra/Oura verify an HMAC over the raw bytes, CLAUDE.md rule 7).

const MOUNTS = ['terra', 'strava', 'oura'] as const;
type Provider = (typeof MOUNTS)[number];

export function createWebhooksApp(providers: readonly string[]): Express {
  const enabled = providers.filter((p): p is Provider => (MOUNTS as readonly string[]).includes(p));
  if (enabled.length === 0)
    throw new Error('WEBHOOK_PROVIDERS must list terra, strava and/or oura');
  registerDefaultAdapters();

  const app = express();
  app.disable('x-powered-by');
  const webhooks = express.Router();
  if (enabled.includes('terra')) webhooks.use('/terra', terraWebhookRouter());
  if (enabled.includes('strava')) {
    webhooks.use('/strava', stravaWebhookRouter({ ingest: lazyStravaIngest() }));
  }
  if (enabled.includes('oura')) webhooks.use('/oura', createOuraWebhookRouter());
  app.use('/api/v1/webhooks', webhooks);
  return app;
}

type Handler = ReturnType<typeof serverless>;
let inner: Handler | undefined;

export const handler: Handler = async (event, context) => {
  await ensureBootstrapped();
  inner ??= serverless(
    createWebhooksApp((process.env.WEBHOOK_PROVIDERS ?? '').split(',').map((s) => s.trim())),
  );
  return inner(event, context);
};
