import express, { type Express } from 'express';

// The same Express app runs locally (server.ts) and in Lambda via serverless-http (lambda.ts).
export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  const v1 = express.Router();
  v1.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.use('/api/v1', v1);

  return app;
}
