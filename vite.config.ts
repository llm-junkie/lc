import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath, URL } from 'node:url';

const spineBuilderPath = fileURLToPath(new URL('./theme/spine-builder.html', import.meta.url));

/** Modern Tauri WebViews support woff2, so do not emit KaTeX's woff/ttf fallbacks. */
function katexWoff2OnlyPlugin(): Plugin {
  return {
    name: 'lc-katex-woff2-only',
    enforce: 'pre',
    transform(code, id) {
      const normalized = id.split('?')[0].replaceAll('\\', '/');
      if (!normalized.endsWith('/katex/dist/katex.min.css')) return null;

      let replacements = 0;
      const transformed = code.replace(
        /src:url\(([^)]+\.woff2)\) format\("woff2"\),url\([^)]+\.woff\) format\("woff"\),url\([^)]+\.ttf\) format\("truetype"\)/g,
        (_match, woff2: string) => {
          replacements++;
          return `src:url(${woff2}) format("woff2")`;
        },
      );
      if (replacements === 0) {
        throw new Error('KaTeX CSS no longer matches the woff2-only rewrite');
      }
      return { code: transformed, map: null };
    },
  };
}

/**
 * The spine builder is a standalone page, rather than a React entry point.
 * Serve and emit it explicitly so it works both from the Vite dev server and
 * from the built `dist/` directory. Tauri also packages a native-resource
 * copy because the page is opened by the system browser; the Rust command
 * embeds a final fallback for standalone EXEs copied without resources.
 */
function spineBuilderPlugin(): Plugin {
  return {
    name: 'lc-spine-builder',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if ((req.url ?? '').split('?')[0] !== '/spine-builder.html') {
          next();
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(readFileSync(spineBuilderPath));
      });
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'spine-builder.html',
        source: readFileSync(spineBuilderPath),
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [
    katexWoff2OnlyPlugin(),
    react(),
    spineBuilderPlugin(),
    {
      // CORS + dev proxy. The Vite built-in `server.proxy` option is
      // convenient but its `router` function in Vite 8 is unreliable for
      // the dynamic /lc-proxy/{proto}+{host}/... pattern the client
      // builds. We use a small custom middleware instead — same code
      // path Vite would use, but we own the URL parsing and forwarding
      // so we know it works.
      name: 'lc-cors-headers',
      configureServer(server) {
        // Apply permissive CORS to every response, including the proxy
        // responses that go through this middleware. We also handle the
        // preflight OPTIONS request here so the browser's CORS preflight
        // short-circuits before the proxy logic runs.
        server.middlewares.use((req, res, next) => {
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
          res.setHeader(
            'Access-Control-Allow-Headers',
            // Must list every header LC actually sends upstream, not just the
            // two generic ones. `/lc-proxy` is same-origin so this is never
            // enforced today, but an inaccurate allowlist is a trap for anyone
            // who reaches the proxy cross-origin later.
            'Content-Type, Authorization, x-api-key, anthropic-version',
          );
          if (req.method === 'OPTIONS') {
            res.statusCode = 204;
            res.end();
            return;
          }
          next();
        });

        // Proxy handler. URL pattern: /lc-proxy/{proto}+{host:port}{upstream-path}
        //   /lc-proxy/http+192.168.31.7:1234/v1/models
        //   /lc-proxy/https+lms.example.com:443/api/v1/chat
        //
        // Every proxy request must carry its explicit encoded target.
        server.middlewares.use('/lc-proxy', (req, res) => {
          // `req.url` here is the path AFTER the mount point, e.g.
          //   "/http+192.168.31.7:1234/v1/models"
          // A request without an encoded target is rejected below.
          const url = req.url ?? '/';
          const m = url.match(/^\/(https?)\+([^/]+)(.*)$/);
          let upstream: URL;
          let restOfPath: string;
          if (m) {
            const proto = m[1];
            const hostPort = m[2];
            restOfPath = m[3] || '/';
            upstream = new URL(`${proto}://${hostPort}`);
            // Defense in depth: if a hand-crafted request embedded
            // user-info into the proxy
            // path, the downstream `http.request` would forward
            // it as `Authorization: Basic` — leaking the password
            // to the upstream server and to anyone watching the
            // proxy log. Strip the credentials and reply 400 to
            // make the misconfiguration visible.
            if (upstream.username || upstream.password) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(
                JSON.stringify({
                  error: 'Credentials in proxy URL are not supported',
                  detail: 'Configure credentials via the Authorization header on the upstream request, not in the server URL.',
                }),
              );
              return;
            }
          } else {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Proxy target is required in the request path' }));
            return;
          }

          // Strip a leading slash on restOfPath so URL composition is clean.
          const targetPath = restOfPath.startsWith('/') ? restOfPath : `/${restOfPath}`;

          // If the upstream is configured with a base path (e.g. the user
          // gave "http://host:1234/lms"), preserve that. Empty pathname
          // means hit the host root.
          const finalPath =
            upstream.pathname && upstream.pathname !== '/'
              ? upstream.pathname.replace(/\/$/, '') + targetPath
              : targetPath;

          const isHttps = upstream.protocol === 'https:';
          const lib = isHttps ? https : http;
          const targetOptions: http.RequestOptions = {
            hostname: upstream.hostname,
            port: upstream.port || (isHttps ? 443 : 80),
            path: finalPath,
            method: req.method,
            headers: {
              ...req.headers,
              host: upstream.host,
            },
          };

          const proxyReq = lib.request(targetOptions, (proxyRes) => {
            // Strip hop-by-hop headers and inherit status.
            res.statusCode = proxyRes.statusCode ?? 502;
            Object.entries(proxyRes.headers).forEach(([k, v]) => {
              if (k.toLowerCase() === 'transfer-encoding') return;
              if (v !== undefined) res.setHeader(k, v as string | string[]);
            });
            // Re-assert CORS on the proxied response (in case the
            // upstream didn't include them, and to override any
            // restrictive upstream value).
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader(
              'Access-Control-Allow-Headers',
              'Content-Type, Authorization, x-api-key, anthropic-version',
            );
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
            proxyRes.pipe(res);
          });
          proxyReq.on('error', (err) => {
            console.error(`[lc-proxy] error proxying to ${upstream.origin}:`, err.message);
            if (!res.headersSent) {
              res.statusCode = 502;
              res.setHeader('Content-Type', 'application/json');
            }
            res.end(
              JSON.stringify({
                error: 'Proxy error',
                target: upstream.origin,
                message: err.message,
              }),
            );
          });
          req.pipe(proxyReq);
        });
      },
    },
  ],
  // Both diagram engines are intentionally loaded only when their viewers
  // open. List them explicitly so every dev-server startup pre-bundles the
  // same modules instead of relying on Vite's entry-point discovery. This
  // keeps a long-lived Tauri WebView from holding URLs for optimized files
  // that a later dependency-discovery pass did not recreate.
  optimizeDeps: {
    include: ['mermaid', '@excalidraw/excalidraw'],
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    // Ignore the Rust build artifact dir. Without this, Vite's file
    // watcher tries to watch `src-tauri/target/debug/deps/*.dll`
    // and crashes with EBUSY while cargo is still compiling them
    // (the .dll is opened for writing and locked until link completes).
    // Vite is rendering the React app — Rust's build output is
    // irrelevant to the dev server.
    watch: {
      ignored: [
        '**/src-tauri/target/**',
        '**/src-tauri/Cargo.lock',
      ],
    },
  },
  build: {
    // Tauri's CSP permits packaged fonts through `self` and deliberately does
    // not permit `data:` font URLs. Keep every WOFF2 file external even when it
    // falls below Vite's default 4 KiB inline threshold. KaTeX_Size3 is small
    // enough to cross that threshold and its fallback glyphs cannot stretch
    // matrix delimiters to the full row height.
    assetsInlineLimit(filePath) {
      return filePath.endsWith('.woff2') ? false : undefined;
    },
    // lightningcss (the default CSS transformer in Vite 8) auto-
    // prefixes properties that have wider browser support with the
    // prefix, including `backdrop-filter` → `-webkit-backdrop-filter`.
    // Tauri 2 uses WebView2 (Chromium-based) which has supported
    // unprefixed `backdrop-filter` for years; the WebKit prefix
    // actively causes faulty rendering on Windows EXE (the panel
    // paints incorrectly when the WebKit path is taken).
    //
    // Vite's minify pass overrides `css.lightningcss.targets` with
    // `build.cssTarget` (see vite/dist/.../node.js:21426), so the
    // `targets` we set has to live on `build.cssTarget` to actually
    // take effect during the minify step. Setting it to `chrome88`
    // — Chromium 88 (Jan 2021), the same baseline as recent Tauri 2
    // builds — tells lightningcss to drop the `-webkit-` variant.
    cssTarget: 'chrome88',
    css: {
      transformer: 'lightningcss',
      // (targets intentionally omitted — see build.cssTarget above)
    },
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('react-markdown') || id.includes('remark-gfm') ||
              id.includes('rehype-prism-plus') || id.includes('refractor') ||
              id.includes('mdast-util') || id.includes('micromark') ||
              id.includes('unist-util') || id.includes('hast-util') ||
              id.includes('vfile') || id.includes('space-separated-tokens') ||
              id.includes('comma-separated-tokens') || id.includes('property-information') ||
              id.includes('html-url-attributes') || id.includes('character-entities') ||
              id.includes('decode-named-character-reference') || id.includes('bail') ||
              id.includes('is-plain-obj') || id.includes('ccount') ||
              id.includes('escape-string-regexp') || id.includes('markdown-table') ||
              id.includes('zwitch')) {
            return 'markdown';
          }
          if (id.includes('zustand') || id.includes('use-sync-external-store')) {
            return 'state';
          }
          if (id.includes('/react/') || id.includes('/react-dom/') ||
              id.includes('/scheduler/')) {
            return 'react';
          }
          return undefined;
        },
      },
    },
  },
}));
