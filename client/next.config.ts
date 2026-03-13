import path from "path";

import type { NextConfig } from "next";

const workspaceRoot = path.join(__dirname, "..");

const nextConfig: NextConfig = {
  experimental: {
    externalDir: true,
  },
  outputFileTracingRoot: workspaceRoot,
  turbopack: {
    root: workspaceRoot,
  },
};

export default nextConfig;
