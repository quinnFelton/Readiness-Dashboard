import { createApp } from './app';
import { rateLimitFromEnv } from './middleware/rate-limit';

const port = Number(process.env.PORT ?? 4000);

// Local dev only: the same throttle numbers as the API Gateway stage (RATE_LIMIT=off to disable).
createApp({ rateLimit: rateLimitFromEnv() }).listen(port, () => {
  console.log(`api listening on http://localhost:${port}`);
});
