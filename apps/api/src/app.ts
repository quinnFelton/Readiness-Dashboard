import express, { type Express } from 'express';
import { athleteEventsRouter } from './athlete-events/routes';
import { authRouter } from './auth/routes';
import { comparisonRouter } from './comparison/routes';
import { connectionsRouter } from './connections/routes';
import { feedbackRouter } from './feedback/routes';
import { createOuraWebhookRouter } from './providers/oura/webhook';
import { lazyStravaIngest, registerDefaultAdapters } from './providers/register-all';
import { scoresRouter } from './scores/routes';
import { trendsRouter } from './trends/routes';
import { usersRouter } from './users/routes';
import { stravaWebhookRouter } from './webhooks/strava/routes';
import { terraWebhookRouter } from './webhooks/terra/router';

export const WEBHOOK_PROVIDERS = ['terra', 'strava', 'oura'] as const;
export type WebhookProvider = (typeof WEBHOOK_PROVIDERS)[number];

export interface CreateAppOptions {
  /**
   * Which route groups to mount (PLAN §11: the REST API and each provider's webhook receiver run as
   * separate Lambdas with separate roles). `all` (default) is the local server / single-Lambda shape.
   */
  mount?: 'all' | 'api' | 'webhooks';
  /** Webhook routers to mount when webhooks are mounted. Default: all of WEBHOOK_PROVIDERS. */
  webhookProviders?: readonly WebhookProvider[];
}

// The same Express app runs locally (server.ts) and in Lambda via serverless-http (lambda.ts, and the
// split entrypoints in lambda/api.ts and lambda/webhooks.ts).
export function createApp(opts: CreateAppOptions = {}): Express {
  const mount = opts.mount ?? 'all';
  const providers = new Set(opts.webhookProviders ?? WEBHOOK_PROVIDERS);

  // Real provider adapters from env config; idempotent and a no-op for unconfigured providers.
  registerDefaultAdapters();

  const app = express();
  app.disable('x-powered-by');

  // Provider webhooks (PLAN §6) are mounted BEFORE the global express.json(): Terra and Oura verify
  // an HMAC over the exact raw bytes (CLAUDE.md rule 7), so each router brings its own body parser
  // (express.raw for Terra/Oura, express.json for Strava, which has no payload signature). Auth here
  // is the signature / verify token, not a user session.
  if (mount !== 'api') {
    const webhooks = express.Router();
    if (providers.has('terra')) webhooks.use('/terra', terraWebhookRouter());
    if (providers.has('strava')) {
      webhooks.use('/strava', stravaWebhookRouter({ ingest: lazyStravaIngest() }));
    }
    // GET verification challenge + POST events
    if (providers.has('oura')) webhooks.use('/oura', createOuraWebhookRouter());
    app.use('/api/v1/webhooks', webhooks);
  }
  if (mount === 'webhooks') return app;

  app.use(express.json());

  const v1 = express.Router();
  v1.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  v1.use('/auth', authRouter());
  v1.use('/users', usersRouter());
  v1.use('/connections', connectionsRouter()); // requireUser is applied inside the router
  // Phase 5b (PLAN §8.4, §8.7, §8.8). Each router applies requireUser + requireSelfOrMaster (or
  // requireMaster for /comparison) on its own routes, server-side (CLAUDE.md rule 3).
  v1.use('/scores', scoresRouter());
  v1.use('/trends', trendsRouter());
  v1.use('/feedback', feedbackRouter());
  v1.use('/athlete-events', athleteEventsRouter());
  v1.use('/comparison', comparisonRouter()); // master only
  app.use('/api/v1', v1);

  return app;
}
