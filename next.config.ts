import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // CSV lead files are uploaded through a Server Action. Vercel caps request bodies at about 4.5MB.
    serverActions: { bodySizeLimit: "4mb" },
  },
};

export default nextConfig;
