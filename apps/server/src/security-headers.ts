import type { Env, Hono } from "hono";
import { NONCE, secureHeaders } from "hono/secure-headers";

type SecurityHeadersOptions = {
  // connect-src list for the app CSP (self + optional CORS origin + S3 origin).
  cspConnectSrc: string[];
  // sha256 hash authorizing the inlined anti-FOUC theme bootstrap script.
  themeInitCspHash: string;
};

/** The subset of the S3 client config that determines the presigned-URL origin. */
export type S3CspConfig = {
  /** Parsed bucket name — no key prefix (see parseBucketSpec in storage.ts). */
  bucket: string;
  /** S3_REGION (used only for the AWS-default-endpoint case). */
  region: string;
  /** S3_ENDPOINT — undefined for real AWS S3, set for R2/B2/MinIO/Spaces/etc. */
  endpoint?: string;
  /** S3_FORCE_PATH_STYLE — path-style vs virtual-hosted addressing. */
  forcePathStyle: boolean;
};

/**
 * Derive the CSP `connect-src` origin(s) the browser hits for direct-to-S3
 * uploads — the presigned PUTs in asset-client.ts. Without
 * these, that upload `fetch` is blocked as a Content-Security-Policy violation
 * whenever the bucket lives on a different origin than the app (which is every
 * real deployment). Read-side traffic (images) is proxied
 * same-origin through /api/images/:id, so it needs nothing
 * here — only the browser→S3 write path does.
 *
 * The origin must mirror exactly how the AWS SDK addresses the bucket in
 * packages/api/src/lib/storage.ts, which passes { region, endpoint,
 * forcePathStyle } straight to `new S3Client(...)`. CSP matches on origin only
 * (scheme + host + port), so the object key / bucket-in-path is irrelevant —
 * only the host differs between the addressing styles:
 *
 *   - custom endpoint + path-style      → <endpoint-origin>
 *   - custom endpoint + virtual-hosted  → https://<bucket>.<endpoint-host>
 *   - no endpoint (AWS) + path-style     → https://s3.<region>.amazonaws.com
 *   - no endpoint (AWS) + virtual-hosted → https://<bucket>.s3.<region>.amazonaws.com
 *
 * Returns [] when the bucket is unset (S3 disabled), so the caller's policy is
 * byte-identical to the pre-S3 default.
 *
 * Exactly ONE origin is emitted per config — whichever addressing style the SDK
 * will actually use. Emitting both as a "safety net" would be a real weakening:
 * the bare regional origin `https://s3.<region>.amazonaws.com` is writable
 * path-style by *every* AWS account, so allowing it lets injected script POST
 * stolen data to an attacker's own bucket — precisely the exfiltration
 * `connect-src` exists to prevent. The addressing style is computable
 * (`isVirtualHostableBucket` below), so compute it instead of allowing both.
 */
export function s3ConnectSrcOrigins(config: S3CspConfig): string[] {
  const { bucket, region, endpoint, forcePathStyle } = config;
  if (!bucket) return [];

  // The SDK silently falls back to path-style for a bucket name that can't be a
  // DNS label, whatever `forcePathStyle` says.
  const pathStyle = forcePathStyle || !isVirtualHostableBucket(bucket);

  if (endpoint) {
    let base: URL;
    try {
      base = new URL(endpoint);
    } catch {
      // A malformed S3_ENDPOINT can't yield an origin — the S3 client itself
      // would fail on it. Add nothing rather than a garbage source.
      return [];
    }
    if (pathStyle) return [base.origin];
    // Virtual-hosted: the SDK prepends the bucket to the endpoint host.
    return [`${base.protocol}//${bucket}.${base.host}`];
  }

  // No endpoint → real AWS S3. Regional endpoint host is s3.<region>.amazonaws.com.
  const host = `s3.${region}.amazonaws.com`;
  return pathStyle ? [`https://${host}`] : [`https://${bucket}.${host}`];
}

/**
 * Mirrors the AWS SDK's `isVirtualHostableS3Bucket` for the HTTPS case: the
 * bucket has to be a single DNS label — 3–63 chars, lowercase alphanumeric or
 * hyphen, not starting or ending with a hyphen. A dot disqualifies it (the
 * wildcard TLS cert only covers one label), as does any uppercase character.
 * Names that fail are addressed path-style even with `forcePathStyle` unset.
 */
function isVirtualHostableBucket(bucket: string): boolean {
  return bucket.length >= 3 && bucket.length <= 63 && /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(bucket);
}

/**
 * Registers the global security headers.
 *
 * Order is load-bearing. `secureHeaders` writes the app Content-Security-Policy
 * *after* `await next()`, and in Hono's onion model the OUTER middleware's
 * post-`next()` code runs last. The raw-asset override must therefore be
 * registered BEFORE `secureHeaders` so it sits outside it and its `sandbox`
 * value wins. Registering it after `secureHeaders` lets `secureHeaders` clobber
 * the override back to the app policy — the exact bug this ordering prevents.
 */
export function mountSecurityHeaders<E extends Env>(
  app: Hono<E>,
  { cspConnectSrc, themeInitCspHash }: SecurityHeadersOptions,
): void {
  // Raw asset responses get a stricter CSP (`sandbox`) than the app shell.
  app.use("/api/assets/:id", async (c, next) => {
    await next();
    if (c.res.ok) {
      c.res.headers.set("Content-Security-Policy", "sandbox");
    }
  });

  // Secure-headers — sets a battery of security headers (X-Content-Type-Options,
  // X-Frame-Options, Strict-Transport-Security, etc.) on every response.
  app.use(
    "/*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        // NONCE generates a fresh per-request nonce, exposed as
        // c.get("secureHeadersNonce"). The SSR handler forwards it to TanStack
        // Start so its inline hydration scripts carry a matching nonce.
        //
        // 'wasm-unsafe-eval' authorizes WebAssembly.compile/instantiate for the
        // lazy heic-to HEIC decoder (asset-image-prepare.ts). It is NOT
        // 'unsafe-eval' — string-to-JS evaluation (eval / new Function) stays
        // blocked; only WASM compilation is allowed. Never add 'unsafe-eval'.
        scriptSrc: [NONCE, "'self'", "'wasm-unsafe-eval'", themeInitCspHash],
        // Intentional template tradeoff: Tailwind/shadcn-driven app UI and AI
        // generated small-business customizations often rely on inline styles.
        // Keep script-src strict; remove this only after auditing app-specific UI.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        // The installed heic-to/csp build runs its decoder in a worker whose
        // source is embedded as a string and started via
        // new Worker(URL.createObjectURL(new Blob(...))) — a blob: worker.
        // Without worker-src, CSP3 falls back to script-src, which blocks
        // blob:. blob: is allowed here ONLY; never add it to script-src.
        workerSrc: ["'self'", "blob:"],
        connectSrc: cspConnectSrc,
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        // Injected markup cannot POST credentials to an attacker origin. Safe
        // with genericOAuth: the SSO handshake is redirect-based, not a form
        // POST. A SAML IdP using HTTP-POST binding would need its origin added.
        formAction: ["'self'"],
      },
    }),
  );
}
