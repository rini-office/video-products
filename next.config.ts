import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Neon uses WebSocket (not native addon), no serverExternalPackages needed
};

export default nextConfig;
