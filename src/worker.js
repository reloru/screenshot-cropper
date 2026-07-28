// Cloudflare Worker: serves ./public and stamps the security headers.
//
// `run_worker_first: true` in wrangler.jsonc routes every request through here
// first; without it Cloudflare would serve matching static assets directly and
// none of these headers would land.
//
// The Content-Security-Policy is the interesting one. `connect-src 'none'`
// means the page is structurally incapable of sending your screenshot
// anywhere — no fetch, no XHR, no WebSocket, no beacon. "Nothing is uploaded"
// is enforced by the browser, not just promised in the copy.

const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "script-src 'self'",
  "style-src 'self'",
  // blob: covers the object URL used by the <img> decode fallback on older
  // Safari; data: keeps the inline SVG icon working.
  "img-src 'self' blob: data:",
  "connect-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export default {
  async fetch(request, env) {
    const asset = await env.ASSETS.fetch(request);
    const response = new Response(asset.body, asset);
    const headers = response.headers;

    headers.set("content-security-policy", CSP);
    headers.set("strict-transport-security", "max-age=63072000; includeSubDomains");
    headers.set("x-content-type-options", "nosniff");
    headers.set("x-frame-options", "DENY");
    headers.set("referrer-policy", "no-referrer");
    // The app reads a file you hand it and nothing else.
    headers.set(
      "permissions-policy",
      "camera=(), microphone=(), geolocation=(), browsing-topics=(), interest-cohort=()",
    );
    // Cross-origin isolation headers cost nothing here and keep the page out of
    // other people's frames and popups.
    headers.set("cross-origin-opener-policy", "same-origin");
    headers.set("cross-origin-resource-policy", "same-origin");

    return response;
  },
};
