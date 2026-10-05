import type { Express } from 'express';
import serverless from 'serverless-http';
import { WEBHOOK_PROVIDERS, type WebhookProvider, createApp } from '../app';
import { REPLAY_HINT_HEADER } from '../webhooks/strava/routes';
import { ensureBootstrapped } from './bootstrap';

// PLAN §11: webhook receivers are separate Lambdas so each role holds only its own provider's
// secrets. One bundle, three deployments: WEBHOOK_PROVIDERS (e.g. "terra") picks which routers this
// function mounts. Mounting is app.ts's (createApp({ mount: 'webhooks' }), integration stage E), so
// paths and parser order can't drift from the local server: webhooks BEFORE any global body parser,
// because Terra/Oura verify an HMAC over the raw bytes (CLAUDE.md rule 7).

export function createWebhooksApp(providers: readonly string[]): Express {
  const enabled = providers.filter((p): p is WebhookProvider =>
    (WEBHOOK_PROVIDERS as readonly string[]).includes(p),
  );
  if (enabled.length === 0)
    throw new Error('WEBHOOK_PROVIDERS must list terra, strava and/or oura');
  return createApp({ mount: 'webhooks', webhookProviders: enabled });
}

/** Minimal Lambda client surface, so tests can inject a fake. */
export interface LambdaInvoker {
  send(command: unknown): Promise<unknown>;
}

interface HttpEvent {
  rawPath?: string;
  requestContext?: { http?: { method?: string } };
}

/**
 * Strava answers within ~1.5 s and finishes ingest in the background, but Lambda freezes the process
 * after the response. Right after a successful POST (DB already awake, so this costs nothing extra)
 * we async-invoke the replay Lambda to finish anything left `pending`. Best effort: a failure here
 * is covered by the fallback schedule. Needs `lambda:InvokeFunction` on that ONE function.
 */
export async function kickStravaReplay(
  event: HttpEvent,
  statusCode: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
  invoker?: LambdaInvoker,
  /**
   * Response headers. When given, the replay is kicked only if the router flagged a still-pending
   * event (security review M4: forged / duplicate / unknown-owner POSTs answer 200 too and must not
   * each start a Lambda). Omit to keep the older "any 200 POST" behaviour.
   */
  headers?: Record<string, unknown>,
): Promise<boolean> {
  const fn = env.STRAVA_REPLAY_FUNCTION;
  const isStravaPost =
    event.requestContext?.http?.method === 'POST' &&
    event.rawPath?.startsWith('/api/v1/webhooks/strava');
  if (!fn || !isStravaPost || statusCode !== 200) return false;
  if (headers !== undefined && String(headers[REPLAY_HINT_HEADER]) !== '1') return false;
  try {
    const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
    await (invoker ?? new LambdaClient({})).send(
      new InvokeCommand({
        FunctionName: fn,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify({ pendingAfterSec: 0 })),
      }),
    );
    return true;
  } catch (err) {
    console.warn(`strava replay kick failed: ${err instanceof Error ? err.name : 'error'}`);
    return false;
  }
}

type Handler = ReturnType<typeof serverless>;
let inner: Handler | undefined;

export const handler: Handler = async (event, context) => {
  await ensureBootstrapped();
  inner ??= serverless(
    createWebhooksApp((process.env.WEBHOOK_PROVIDERS ?? '').split(',').map((s) => s.trim())),
  );
  const result = (await inner(event, context)) as {
    statusCode?: number;
    headers?: Record<string, unknown>;
  };
  await kickStravaReplay(
    event as HttpEvent,
    result.statusCode,
    process.env,
    undefined,
    result.headers ?? {},
  );
  // The hint is for this wrapper only; do not hand it to Strava.
  if (result.headers) delete result.headers[REPLAY_HINT_HEADER];
  return result;
};
