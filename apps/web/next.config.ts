import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
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
