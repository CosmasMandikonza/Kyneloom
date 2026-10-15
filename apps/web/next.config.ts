import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source and are consumed directly.
  transpilePackages: ['@kyneloom/contracts', '@kyneloom/match-core', '@kyneloom/scene-renderer'],
};

export default nextConfig;
