// /scores shares its implementation with /trends (same auth, range and classifier rules); see
// trends/routes.ts. Mount at /api/v1/scores (integrator).
export { scoresRouter } from '../trends/routes';
export type { ReadRouterDeps } from '../trends/routes';
