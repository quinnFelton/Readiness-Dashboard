import type { Node } from 'constructs';

// Everything environment-specific comes from CDK context (`-c key=value` or cdk.json), never from code:
// no account ids, no secrets. Account/region come from the CLI credentials (CDK_DEFAULT_*).

export type Stage = 'dev' | 'prod';
export type NatMode = 'instance' | 'gateway';

export interface InfraConfig {
  stage: Stage;
  /** Resource name prefix, e.g. `rd-dev`. */
  prefix: string;
  /** Secrets Manager path prefix, e.g. `rd/dev`. */
  secretPrefix: string;
  /** SSM parameter path for the API base URL (read by the Amplify build). */
  apiUrlParam: string;
  isProd: boolean;
  natMode: NatMode;
  alarmEmail?: string;
  logRetentionDays: number;
  db: {
    minAcu: number;
    maxAcu: number;
    autoPauseMinutes: number;
    backupDays: number;
    /** Master password rotation interval in days; 0 = off. Only the `migrate` function uses it. */
    rotationDays: number;
  };
  throttle: { rateLimit: number; burstLimit: number };
  /**
   * Tighter per-route limit for the unauthenticated Strava POST (security review M4): real traffic is
   * a few events per ride, so a forged flood is cut off long before it wakes Aurora or the replay.
   */
  stravaWebhookThrottle: { rateLimit: number; burstLimit: number };
  /** EventBridge Scheduler expressions; `undefined` = schedule disabled ("off"). */
  schedules: {
    ouraSync?: string;
    ouraSubscriptions?: string;
    stravaReplay?: string;
    webhookTtl?: string;
    /** Works through queued history-rebuild requests (bounded per run). */
    historyRebuild?: string;
  };
  /** Per-invocation bounds of the history rebuild (apps/api/src/fatigue-fitness/history-rebuild.ts). */
  historyRebuild: { maxDates: number; maxUsers: number };
  /** A failing Strava webhook event is retried this many times, then abandoned (rule 9: config). */
  stravaReplayMaxAttempts: number;
  /** Deploy the one-off first-master function (DEPLOY.md). Default false; remove it after use. */
  enableFirstMaster: boolean;
  webhookTtlDays: number;
  ouraSandbox: boolean;
  web: {
    /** e.g. https://github.com/owner/repo — omit to create the Amplify app without a repo. */
    repository?: string;
    branch: string;
    autoBuild: boolean;
    /** Custom domain you attach in Amplify (used only to compute APP_URL / NEXTAUTH_URL). */
    domain?: string;
  };
  github: {
    /** owner/repo allowed to assume the deploy roles via OIDC. */
    repo?: string;
    /** Reuse an existing account-wide GitHub OIDC provider (only one per account is allowed). */
    existingProviderArn?: string;
  };
  bootstrapQualifier: string;
}

const SCHEDULE_RE = /^(rate|cron|at)\(.+\)$/;

export function loadConfig(node: Node): InfraConfig {
  const ctx = (k: string): string | undefined => {
    const v: unknown = node.tryGetContext(k);
    return v === undefined || v === null || v === '' ? undefined : String(v);
  };
  const num = (k: string, d: number, min = 0): number => {
    const raw = ctx(k);
    if (raw === undefined) return d;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min)
      throw new Error(`context "${k}" must be a number >= ${min}`);
    return n;
  };
  const bool = (k: string, d: boolean): boolean => {
    const raw = ctx(k);
    if (raw === undefined) return d;
    if (!['true', 'false'].includes(raw)) throw new Error(`context "${k}" must be true or false`);
    return raw === 'true';
  };
  const schedule = (k: string, d: string): string | undefined => {
    const raw = ctx(k) ?? d;
    if (raw === 'off') return undefined;
    if (!SCHEDULE_RE.test(raw)) {
      throw new Error(`context "${k}" must be "off" or a Scheduler expression like rate(6 hours)`);
    }
    return raw;
  };

  const stage = (ctx('stage') ?? 'dev') as Stage;
  if (stage !== 'dev' && stage !== 'prod') throw new Error('context "stage" must be dev or prod');
  const natMode = (ctx('natMode') ?? 'instance') as NatMode;
  if (natMode !== 'instance' && natMode !== 'gateway') {
    throw new Error('context "natMode" must be instance or gateway');
  }
  const isProd = stage === 'prod';

  const minAcu = num('dbMinAcu', 0);
  const maxAcu = num('dbMaxAcu', 2, 0.5);
  if (minAcu > maxAcu) throw new Error('dbMinAcu must be <= dbMaxAcu');
  // Auto-pause needs min capacity 0 and an idle time of 5 min (300 s) to 24 h.
  const autoPauseMinutes = num('dbAutoPauseMinutes', 5, 5);
  if (autoPauseMinutes > 1440) throw new Error('dbAutoPauseMinutes must be <= 1440');

  return {
    stage,
    prefix: `rd-${stage}`,
    secretPrefix: `rd/${stage}`,
    apiUrlParam: `/rd/${stage}/api-url`,
    isProd,
    natMode,
    alarmEmail: ctx('alarmEmail'),
    logRetentionDays: num('logRetentionDays', isProd ? 30 : 14, 1),
    db: {
      minAcu,
      maxAcu,
      autoPauseMinutes,
      backupDays: num('dbBackupDays', isProd ? 7 : 1, 1),
      rotationDays: num('dbRotationDays', 30, 0),
    },
    throttle: { rateLimit: num('throttleRate', 20, 1), burstLimit: num('throttleBurst', 40, 1) },
    stravaWebhookThrottle: {
      rateLimit: num('throttleStravaRate', 5, 1),
      burstLimit: num('throttleStravaBurst', 10, 1),
    },
    schedules: {
      // Oura has webhooks, so this is a once-a-day safety net: it must not keep Aurora awake.
      ouraSync: schedule('ouraSyncSchedule', 'cron(0 10 * * ? *)'),
      // No DB access; renews Oura webhook subscriptions before they expire.
      ouraSubscriptions: schedule('ouraSubscriptionsSchedule', 'cron(30 9 * * ? *)'),
      // Fallback only: the Strava webhook kicks the replay itself right after answering. A
      // few-minute tick would keep the database awake around the clock.
      stravaReplay: schedule('stravaReplaySchedule', 'rate(6 hours)'),
      webhookTtl: schedule('webhookTtlSchedule', 'cron(5 10 * * ? *)'),
      // Daily, right after the other daily jobs so Aurora is already awake (no extra resume).
      historyRebuild: schedule('historyRebuildSchedule', 'cron(20 10 * * ? *)'),
    },
    historyRebuild: {
      maxDates: num('historyRebuildMaxDates', 120, 1),
      maxUsers: num('historyRebuildMaxUsers', 10, 1),
    },
    stravaReplayMaxAttempts: num('stravaReplayMaxAttempts', 5, 1),
    enableFirstMaster: bool('enableFirstMaster', false),
    webhookTtlDays: num('webhookTtlDays', 30, 1),
    ouraSandbox: bool('ouraSandbox', false),
    web: {
      repository: ctx('webRepository'),
      branch: ctx('webBranch') ?? (isProd ? 'main' : 'dev'),
      autoBuild: bool('webAutoBuild', false),
      domain: ctx('webDomain'),
    },
    github: { repo: ctx('githubRepo'), existingProviderArn: ctx('githubOidcProviderArn') },
    bootstrapQualifier: ctx('bootstrapQualifier') ?? 'hnb659fds',
  };
}
