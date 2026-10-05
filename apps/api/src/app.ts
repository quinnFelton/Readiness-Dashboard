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

// The same Express app runs locally (server.ts) and in Lambda via serverless-http (lambda.ts).
export function createApp(): Express {
  // Real provider adapters from env config; idempotent and a no-op for unconfigured providers.
  registerDefaultAdapters();

  const app = express();
  app.disable('x-powered-by');

  // Provider webhooks (PLAN §6) are mounted BEFORE the global express.json(): Terra and Oura verify
  // an HMAC over the exact raw bytes (CLAUDE.md rule 7), so each router brings its own body parser
  // (express.raw for Terra/Oura, express.json for Strava, which has no payload signature). Auth here
  // is the signature / verify token, not a user session.
  const webhooks = express.Router();
  webhooks.use('/terra', terraWebhookRouter());
  webhooks.use('/strava', stravaWebhookRouter({ ingest: lazyStravaIngest() }));
  webhooks.use('/oura', createOuraWebhookRouter()); // GET verification challenge + POST events
  app.use('/api/v1/webhooks', webhooks);

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
