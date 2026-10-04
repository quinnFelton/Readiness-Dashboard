// ProviderAdapter<T> contract + registry (PLAN §6). Concrete adapters (oura, strava, terra)
// live in their own phases' folders and register themselves into the registry.
export * from './types';
export * from './registry';
// phase 3b: one additive re-export so apps/api can import the Terra adapter (no deep-import path exists)
export * from './terra';
// integration stage C: Oura and Strava are reachable from the package root too (Strava also keeps
// its "./strava" subpath export).
export * from './oura';
export * from './strava';
