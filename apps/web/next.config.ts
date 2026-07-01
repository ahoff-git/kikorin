import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Turbopack (Next.js 16 default) natively supports WebAssembly async modules.
  // An empty turbopack config silences the "webpack config but no turbopack config" error.
  turbopack: {},
  transpilePackages: [
    "@kikorin/adapter",
    "@kikorin/react",
    "@kikorin/netcode",
    "@kikorin/ecs",
    "@kikorin/engine",
    "@kikorin/events",
    "@kikorin/util",
    "@kikorin/system-commands",
    "@kikorin/system-controls",
    "@kikorin/system-entity-cleanup",
    "@kikorin/system-experience",
    "@kikorin/system-flaginator",
    "@kikorin/system-health",
    "@kikorin/system-movement",
    "@kikorin/system-physics",
    "@kikorin/system-rendering",
    "@kikorin/system-time",
    "@kikorin/system-ui-bridge",
  ],
};

export default nextConfig;
