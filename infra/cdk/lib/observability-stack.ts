import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';
import type { ApiStack } from './api-stack';
import type { InfraConfig } from './config';

export interface ObservabilityStackProps extends StackProps {
  config: InfraConfig;
  api: ApiStack;
}

/** Log line apps/api/src/lambda/oura-sync.ts writes when any user's sync failed (counts only). */
export const OURA_SYNC_FAILURE_MARKER = 'oura_sync_failures';

/**
 * CloudWatch alarms -> SNS -> email (PLAN §11). Six alarms, i.e. inside the CloudWatch free tier of
 * 10 alarms. The recipient comes from the `alarmEmail` context value; with none, the topic is still
 * created so you can subscribe later (SNS asks the recipient to confirm the subscription).
 */
export class ObservabilityStack extends Stack {
  readonly topic: sns.Topic;
  readonly alarms: cloudwatch.Alarm[] = [];

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);
    const { config, api } = props;

    this.topic = new sns.Topic(this, 'Alarms', {
      topicName: `${config.prefix}-alarms`,
      displayName: `Readiness dashboard (${config.stage}) alarms`,
      enforceSSL: true,
    });
    if (config.alarmEmail) {
      this.topic.addSubscription(new subscriptions.EmailSubscription(config.alarmEmail));
    }
    const action = new cwActions.SnsAction(this.topic);
    const period = Duration.minutes(5);

    const alarm = (
      alarmId: string,
      description: string,
      metric: cloudwatch.IMetric,
      threshold: number,
    ) => {
      const a = new cloudwatch.Alarm(this, alarmId, {
        alarmName: `${config.prefix}-${alarmId}`,
        alarmDescription: description,
        metric,
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      a.addAlarmAction(action);
      this.alarms.push(a);
      return a;
    };
    const errors = (name: string) =>
      api.functions[name]!.metricErrors({ period, statistic: 'Sum' });
    const sum = (expression: string, names: string[]) =>
      new cloudwatch.MathExpression({
        expression,
        period,
        usingMetrics: Object.fromEntries(names.map((n, i) => [`e${i + 1}`, errors(n)] as const)),
      });

    // 1. REST API: Lambda errors and 5xx from API Gateway.
    alarm('api-errors', 'REST API Lambda threw', errors('api'), 1);
    alarm(
      'api-5xx',
      'API Gateway returned 5xx (>=5 in 5 min)',
      api.httpApi.metricServerError({ period, statistic: 'Sum' }),
      5,
    );

    // 2. Webhook receivers crashed (distinct from rejected/unauthenticated requests, alarm 5).
    alarm(
      'webhook-errors',
      'A webhook Lambda threw',
      sum('e1+e2+e3', ['webhook-terra', 'webhook-strava', 'webhook-oura']),
      1,
    );

    // 3. Scheduled jobs crashed (sync / subscription renewal / replay / TTL).
    alarm(
      'scheduled-job-errors',
      'A scheduled Lambda threw (oura-sync, oura-subscriptions, strava-replay, webhook-ttl)',
      sum('e1+e2+e3+e4', ['oura-sync', 'oura-subscriptions', 'strava-replay', 'webhook-ttl']),
      1,
    );

    // 4. Oura sync "failures": the job isolates per-user failures and returns normally, so the
    // function never errors. It logs a counts-only marker line instead; alarm on that.
    const syncFailures = new logs.MetricFilter(this, 'OuraSyncFailures', {
      logGroup: api.functions['oura-sync']!.logGroup,
      filterPattern: logs.FilterPattern.literal(`"${OURA_SYNC_FAILURE_MARKER}"`),
      metricNamespace: `${config.prefix}/App`,
      metricName: 'OuraSyncFailures',
      metricValue: '1',
      defaultValue: 0,
    });
    alarm(
      'oura-sync-failures',
      'Oura sync failed for at least one user',
      syncFailures.metric({ period, statistic: 'Sum' }),
      1,
    );

    // 5. Webhook authentication failures (Terra signature 401, Strava/Oura verify-token 403/401):
    // counted from the API access log, so no payload is ever inspected.
    const authFailures = new logs.MetricFilter(this, 'WebhookAuthFailures', {
      logGroup: api.accessLogGroup,
      filterPattern: logs.FilterPattern.literal(
        '{ ($.routeKey = "*webhooks*") && (($.status = 401) || ($.status = 403)) }',
      ),
      metricNamespace: `${config.prefix}/App`,
      metricName: 'WebhookAuthFailures',
      metricValue: '1',
      defaultValue: 0,
    });
    alarm(
      'webhook-auth-failures',
      'Webhook requests failed signature/token verification (>=3 in 5 min)',
      authFailures.metric({ period, statistic: 'Sum' }),
      3,
    );

    // Only CloudWatch may publish to the topic.
    this.topic.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['sns:Publish'],
        principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
        resources: [this.topic.topicArn],
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    );

    new CfnOutput(this, 'AlarmTopicArn', { value: this.topic.topicArn });
  }
}
