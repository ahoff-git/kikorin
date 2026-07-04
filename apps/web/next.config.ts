import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Turbopack (Next.js 16 default) natively supports WebAssembly async modules.
  // An empty turbopack config silences the "webpack config but no turbopack config" error.
  turbopack: {},
  transpilePackages: [
    "@kikorin/adapter",
    "@kikorin/events",
    "@kikorin/react",
    "@kikorin/system-rendering",
    "@kikorin/util",
  ],
};

export default nextConfig;
