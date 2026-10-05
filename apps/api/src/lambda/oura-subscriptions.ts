import { handler as subscriptionsHandler } from '../providers/oura/subscriptions-job';
import { ensureBootstrapped } from './bootstrap';

// Daily scheduled renewal of Oura webhook subscriptions. Talks only to Oura (no DB), so this function
// runs outside the VPC and its role can read only the Oura secret.
export const handler = async () => {
  await ensureBootstrapped();
  return subscriptionsHandler();
};
