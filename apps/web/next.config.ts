import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source; let Next compile them.
  transpilePackages: ['@rd/shared-types', '@rd/scoring-engine', '@rd/provider-adapters'],
};

export default nextConfig;
