import { App } from 'aws-cdk-lib';
import { buildStacks } from '../lib/app';

// CDK app entry point (PLAN §11). Stage and every other knob come from context:
//   npx cdk synth -c stage=prod -c alarmEmail=me@example.com
// See infra/cdk/DEPLOY.md. Deployment is a human step; nothing here runs `cdk deploy`.
buildStacks(new App());
