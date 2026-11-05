/** @type {import('next').NextConfig} */

// Baseline Content-Security-Policy: same-origin scripts only, no plug-in
// content, no framing, no form submission off-site. Inline script/style remain
// allowed because this Next.js build has no per-request nonce plumbing; that
// still blocks the exfiltration vector that mattered here — third-party script
// loading — which is how an XSS would read the zkLogin sessionStorage key.
// Avatar URLs are user-provided HTTPS, so img-src cannot be tighter than https:.
// upgrade-insecure-requests is deliberately omitted: it would rewrite the
// local http:// development origin's own API calls to https and break them.
// Development adds 'unsafe-eval' to script-src: Next.js dev-mode React Fast
// Refresh evaluates compiled modules at runtime, so without it every `next dev`
// page dies on a CSP EvalError before first paint. Production never allows it.
const scriptSrc = process.env.NODE_ENV === "development"
  ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
  : "script-src 'self' 'unsafe-inline'"

const contentSecurityPolicy = [
  "default-src 'self'",
  scriptSrc,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss: ws:",
  "frame-src 'self' https://accounts.google.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ")

const nextConfig = {
  transpilePackages: ["multisig"],
  images: {
    unoptimized: true,
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ]
  },
}

export default nextConfig
