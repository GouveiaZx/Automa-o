import type { NextConfig } from 'next';

const config: NextConfig = {
  experimental: {
    typedRoutes: false,
  },
  transpilePackages: ['@automacao/shared'],
};

export default config;
