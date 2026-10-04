import express, { type Express } from 'express';
import { authRouter } from './auth/routes';
import { usersRouter } from './users/routes';

// The same Express app runs locally (server.ts) and in Lambda via serverless-http (lambda.ts).
export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  const v1 = express.Router();
  v1.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  v1.use('/auth', authRouter());
  v1.use('/users', usersRouter());
  app.use('/api/v1', v1);

  return app;
}
