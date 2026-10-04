import { OuraSubscriptions, ouraConfigFromEnv } from './register';

/**
 * Scheduled entrypoint (e.g. daily EventBridge rule): idempotently creates any missing Oura webhook
 * subscription and renews those about to expire (spec: WebhookSubscriptionModel.expiration_time).
 * Also run once after deploy. Returns labels only ("event_type:data_type"), never secrets.
 * Creating a subscription makes Oura call the GET verification on the webhook router, so deploy that first.
 */
export async function handler() {
  return new OuraSubscriptions(ouraConfigFromEnv()).ensure();
}
