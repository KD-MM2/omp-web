import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const configDir = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(configDir, "package.json"), "utf8")) as { version: string };
let ompVersion = "unknown";
try {
  const ompPkgPath = join(configDir, "node_modules/@oh-my-pi/pi-coding-agent/package.json");
  ompVersion = (JSON.parse(readFileSync(ompPkgPath, "utf8")) as { version: string }).version;
} catch { /* package not found, use default */ }

// mdast-util-gfm-autolink-literal (remark-gfm) ships a RegExp lookbehind that
// Safari parses only from 16.4, which blanked `/` on iOS 16.2 (#753). The loader
// swaps it for an equivalent built at runtime; both bundlers must run it.
const gfmAutolinkEmailLoader = join(configDir, "lib/gfm-autolink-email-loader.cjs");

/**
 * The omp SDK is published as TypeScript sources and imports `bun:` builtins,
 * so webpack must never try to parse it: every `@oh-my-pi/*` request stays a
 * runtime import that Bun resolves itself.
 *
 * `serverExternalPackages` alone is not enough — it leaves the SDK's own
 * transitive entry points (`@oh-my-pi/pi-ai`, `@oh-my-pi/pi-catalog/...`)
 * inside the bundle — so the rule below is applied unconditionally to the
 * whole scope.
 */
const OMP_SDK_REQUEST = /^@oh-my-pi\//;

const nextConfig: NextConfig = {
  // Desktop builds (scripts/stage-desktop.mjs) redirect the production build
  // into src-tauri/server/.next so packaging never touches the dev `.next/`.
  distDir: process.env.OMP_WEB_DIST_DIR || ".next",
  outputFileTracingRoot: configDir,
  experimental: {
    // proxy.ts matches /api/:path*, and Next buffers the request body whenever
    // a proxy is present, capped at 10 MB by default. The upload route accepts
    // up to 100 MB per request, so raise the buffer above that or large uploads
    // are truncated and fail with "Failed to parse body as FormData."
    proxyClientMaxBodySize: "128mb",
  },
  // next/image is only used for the static logo, so the /_next/image optimizer
  // (and its sharp/libheif attack surface, see GHSA-2xp9-vwfh-vxw4) is not needed.
  images: { unoptimized: true },
  // `next dev` runs Turbopack and `next build` runs webpack.
  turbopack: {
    rules: {
      "**/mdast-util-gfm-autolink-literal/lib/index.js": { loaders: [gfmAutolinkEmailLoader] },
    },
  },
  // Node modules keep the syntax they ship unless listed here, and mermaid's
  // lazy diagram chunks are full of class `static {}` blocks (#753).
  transpilePackages: ["mermaid", "@mermaid-js/parser"],
  serverExternalPackages: [
    "node-pty",
    "undici",
    "web-push",
    "@oh-my-pi/pi-coding-agent",
    "@oh-my-pi/pi-agent-core",
    "@oh-my-pi/pi-ai",
    "@oh-my-pi/pi-catalog",
    "@oh-my-pi/pi-tui",
    "@oh-my-pi/pi-utils",
  ],
  webpack: (config, { isServer, nextRuntime }) => {
    // The gfm-email loader must run in every webpack graph, server or browser.
    config.module.rules.push({
      test: /[\\/]mdast-util-gfm-autolink-literal[\\/]lib[\\/]index\.js$/,
      loader: gfmAutolinkEmailLoader,
    });
    if (!isServer || nextRuntime === "edge") {
      // instrumentation.ts has a Node-only dynamic import guarded by
      // NEXT_RUNTIME. Webpack still traces it for the browser fallback unless
      // the server-only module is explicitly excluded.
      config.resolve.alias["@/lib/http-dispatcher"] = false;
      // Next 16.3's `client-development-fallback` graph re-traces server
      // modules for the browser, where `serverExternalPackages` does not apply
      // and node_modules get no TS loader — the SDK's `export type *` sources
      // then die in the raw parser ("Module parse failed"). The browser never
      // executes the SDK, so keep it out of every client-side compile as an
      // external that resolves to `undefined` if anything ever requires it.
      const clientExternals = Array.isArray(config.externals) ? config.externals : [config.externals].filter(Boolean);
      config.externals = [
        ({ request }: { request?: string }, callback: (error?: unknown, result?: string) => void) => {
          if (request && OMP_SDK_REQUEST.test(request)) return callback(undefined, "var void 0");
          return callback();
        },
        ...clientExternals,
      ];
      return config;
    }
    const externals = Array.isArray(config.externals) ? config.externals : [config.externals].filter(Boolean);
    config.externals = [
      ({ request }: { request?: string }, callback: (error?: unknown, result?: string) => void) => {
        // `import`, not `commonjs`: the SDK's package exports declare only an
        // `import` condition, so a `require()` of it cannot resolve at all.
        if (request && OMP_SDK_REQUEST.test(request)) return callback(undefined, `import ${request}`);
        return callback();
      },
      ...externals,
    ];
    return config;
  },
  // Next 16 blocks cross-origin access to dev resources by default. Allow the
  // loopback and the RFC1918 LAN ranges so the dev server stays reachable
  // from other machines on the same LAN.
  allowedDevOrigins: [
    "127.0.0.1",
    "10.*.*.*",
    // 172.16.0.0/12
    "172.16.*.*",
    "172.17.*.*",
    "172.18.*.*",
    "172.19.*.*",
    "172.20.*.*",
    "172.21.*.*",
    "172.22.*.*",
    "172.23.*.*",
    "172.24.*.*",
    "172.25.*.*",
    "172.26.*.*",
    "172.27.*.*",
    "172.28.*.*",
    "172.29.*.*",
    "172.30.*.*",
    "172.31.*.*",
    "192.168.*.*",
  ],
  async headers() {
    return [
      {
        source: "/",
        headers: [
          { key: "Cache-Control", value: "private, no-cache, max-age=0, must-revalidate" },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_OMP_VERSION: ompVersion,
  },
};

export default nextConfig;
