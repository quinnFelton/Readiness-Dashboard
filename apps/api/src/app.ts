import express, { type Express } from 'express';
import { authRouter } from './auth/routes';
import { connectionsRouter } from './connections/routes';
import { createOuraWebhookRouter } from './providers/oura/webhook';
import { lazyStravaIngest, registerDefaultAdapters } from './providers/register-all';
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
  app.use('/api/v1', v1);

  return app;
}
