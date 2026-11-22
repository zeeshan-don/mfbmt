import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

/**
 * Content Security Policy.
 *
 * Next injects inline bootstrap scripts, so `script-src` needs a nonce-free
 * 'unsafe-inline' allowance in development; production keeps 'unsafe-inline'
 * only because the Meta Embedded Signup SDK is loaded from connect.facebook.net
 * and calls inline handlers. Everything else is locked to this origin.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""} https://connect.facebook.net https://web.facebook.com`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.fbcdn.net https://*.facebook.com",
  "font-src 'self' data:",
  `connect-src 'self' https://graph.facebook.com https://www.facebook.com https://web.facebook.com https://*.pusher.com wss://*.pusher.com${isDev ? " ws: wss:" : ""}`,
  "frame-src https://www.facebook.com https://web.facebook.com https://connect.facebook.net",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "upgrade-insecure-requests",
].join("; ");

const nextConfig: NextConfig = {
  // Allows a production build to be produced and run beside a running `next dev`
  // without the two fighting over the same .next directory.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  serverExternalPackages: ["pdfkit", "pdf-parse", "exceljs", "tesseract.js", "sharp", "mupdf"],
  experimental: {
    serverActions: { bodySizeLimit: "12mb" },
  },
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
};

export default nextConfig;
