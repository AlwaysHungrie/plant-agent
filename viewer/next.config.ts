import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "message-api.dhairyashah98.workers.dev" },
    ],
    minimumCacheTTL: 2678400, // 31 days
  },
};

export default nextConfig;
