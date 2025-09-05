// next.config.ts
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  eslint: {
    // Ne bloque pas le build en production si ESLint trouve des erreurs
    ignoreDuringBuilds: true,
  },
  typescript: {
    // Ne bloque pas le build si des erreurs TypeScript existent
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
