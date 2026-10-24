import type { NextConfig } from "next";

// Next loads .env.local before this file, so the Convex CLI's CONVEX_URL
// works as the client URL when NEXT_PUBLIC_CONVEX_URL is not set.
const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_CONVEX_URL:
      process.env.NEXT_PUBLIC_CONVEX_URL ?? process.env.CONVEX_URL ?? "",
  },
  poweredByHeader: false,
  // Share the dashboard as `/live#key=…`: fragments never reach the server,
  // logs or Referer headers. A legacy `?key=` link still works (the client
  // strips it at once), and both carry through this redirect.
  async redirects() {
    return [{ source: "/", destination: "/live", permanent: false }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
