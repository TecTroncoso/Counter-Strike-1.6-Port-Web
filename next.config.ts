import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Keep local and CI builds memory-bounded. The app has only a few routes,
  // while Next.js otherwise starts one page-data worker per available CPU.
  experimental: {
    cpus: 1,
  },
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
