import { App } from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../lib/config';

const cfg = (context: Record<string, unknown> = {}) => loadConfig(new App({ context }).node);

describe('loadConfig', () => {
  it('defaults to a cheap dev stage', () => {
    const c = cfg();
    expect(c).toMatchObject({
      stage: 'dev',
      prefix: 'rd-dev',
      natMode: 'instance',
      isProd: false,
      db: { minAcu: 0, autoPauseMinutes: 5 },
      webhookTtlDays: 30,
    });
    expect(c.apiUrlParam).toBe('/rd/dev/api-url');
  });

  it('parameterises by stage', () => {
    const c = cfg({ stage: 'prod' });
    expect(c).toMatchObject({ prefix: 'rd-prod', secretPrefix: 'rd/prod', isProd: true });
    expect(c.web.branch).toBe('main');
    expect(c.db.backupDays).toBeGreaterThan(cfg().db.backupDays);
  });

  it('makes every schedule a context value and allows "off"', () => {
    const c = cfg({ ouraSyncSchedule: 'cron(0 4 * * ? *)', stravaReplaySchedule: 'off' });
    expect(c.schedules.ouraSync).toBe('cron(0 4 * * ? *)');
    expect(c.schedules.stravaReplay).toBeUndefined();
    // Oura has webhooks: the default sync is a daily safety net, never a few-minute poller.
    expect(cfg().schedules.ouraSync).toMatch(/^cron\(/);
    // The Strava replay is kicked by the webhook; the tick is only a slow fallback.
    expect(cfg().schedules.stravaReplay).toBe('rate(6 hours)');
  });

  it.each([
    [{ stage: 'staging' }, /stage/],
    [{ natMode: 'magic' }, /natMode/],
    [{ ouraSyncSchedule: 'every day' }, /ouraSyncSchedule/],
    [{ dbAutoPauseMinutes: 2 }, /dbAutoPauseMinutes/],
    [{ dbMinAcu: 4, dbMaxAcu: 2 }, /dbMinAcu/],
    [{ webhookTtlDays: 0 }, /webhookTtlDays/],
    [{ ouraSandbox: 'maybe' }, /ouraSandbox/],
  ])('rejects bad context %j', (context, message) => {
    expect(() => cfg(context)).toThrow(message);
  });
});
