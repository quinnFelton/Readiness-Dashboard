/// <reference types="node" />
import { OuraHttpError, OuraRateLimitError } from './adapter';
import type { OuraConfig } from './config';

// Webhook subscription management. Verified against spec 1.41 (docs/openapi-excerpt.json):
//   GET    /v2/webhook/subscription                 -> list of WebhookSubscriptionModel
//   POST   /v2/webhook/subscription                 body CreateWebhookSubscriptionRequest -> 201
//   PUT    /v2/webhook/subscription/renew/{id}      -> 200
//   DELETE /v2/webhook/subscription/{id}            -> 204
// Auth: headers x-client-id + x-client-secret (securitySchemes ClientIdAuth/ClientSecretAuth), NOT a user token.
// One subscription per (event_type, data_type) combination.

/** WebhookSubscriptionModel */
export interface OuraSubscription {
  id: string;
  callback_url: string;
  event_type: string;
  data_type: string;
  expiration_time: string;
}

export interface EnsureResult {
  created: string[]; // "event_type:data_type"
  renewed: string[];
  unchanged: string[];
}

export class OuraSubscriptions {
  constructor(private readonly cfg: OuraConfig) {}

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const http = this.cfg.fetch ?? fetch;
    const res = await http(`${this.cfg.apiBaseUrl}${path}`, {
      method,
      headers: {
        'x-client-id': this.cfg.clientId,
        'x-client-secret': this.cfg.clientSecret,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      const n = Number(res.headers.get('retry-after'));
      throw new OuraRateLimitError(Number.isFinite(n) && n > 0 ? n : 60);
    }
    if (!res.ok) throw new OuraHttpError(res.status); // never include the body
    if (res.status === 204) return null;
    return res.json();
  }

  async list(): Promise<OuraSubscription[]> {
    const r = await this.call('GET', '/v2/webhook/subscription');
    return Array.isArray(r) ? (r as OuraSubscription[]) : [];
  }

  create(args: {
    callbackUrl: string;
    verificationToken: string;
    eventType: string;
    dataType: string;
  }): Promise<OuraSubscription> {
    return this.call('POST', '/v2/webhook/subscription', {
      callback_url: args.callbackUrl,
      verification_token: args.verificationToken,
      event_type: args.eventType,
      data_type: args.dataType,
    }) as Promise<OuraSubscription>;
  }

  renew(id: string): Promise<OuraSubscription> {
    return this.call(
      'PUT',
      `/v2/webhook/subscription/renew/${encodeURIComponent(id)}`,
    ) as Promise<OuraSubscription>;
  }

  async delete(id: string): Promise<void> {
    await this.call('DELETE', `/v2/webhook/subscription/${encodeURIComponent(id)}`);
  }

  /**
   * Idempotent: create any missing (event_type x data_type) subscription for our callback URL and renew
   * those expiring within cfg.subscriptionRenewWithinSec. Safe to run on a schedule.
   * Creating triggers Oura's GET verification against the callback, so the webhook router must be live.
   */
  async ensure(): Promise<EnsureResult> {
    const { webhookCallbackUrl: callbackUrl, webhookVerificationToken: token } = this.cfg;
    if (!callbackUrl || !token)
      throw new Error('webhook callback URL / verification token not configured');
    const now = (this.cfg.now?.() ?? new Date()).getTime();
    const existing = await this.list();
    const out: EnsureResult = { created: [], renewed: [], unchanged: [] };
    for (const dataType of Object.keys(this.cfg.webhookCollections)) {
      for (const eventType of this.cfg.webhookEventTypes) {
        const label = `${eventType}:${dataType}`;
        const sub = existing.find(
          (s) =>
            s.callback_url === callbackUrl &&
            s.event_type === eventType &&
            s.data_type === dataType,
        );
        if (!sub) {
          await this.create({ callbackUrl, verificationToken: token, eventType, dataType });
          out.created.push(label);
        } else if (
          Date.parse(sub.expiration_time) - now <=
          this.cfg.subscriptionRenewWithinSec * 1000
        ) {
          await this.renew(sub.id);
          out.renewed.push(label);
        } else out.unchanged.push(label);
      }
    }
    return out;
  }
}
