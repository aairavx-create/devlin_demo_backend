/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Self-contained server bundle for the Docker image (see Dockerfile).
  output: 'standalone',
  experimental: {
    // Starts the background lead auto-sync (instrumentation.ts).
    instrumentationHook: true,
    serverComponentsExternalPackages: ['postgres'],
  },
};

export default nextConfig;
