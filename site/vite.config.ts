import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";

import { bundleData } from "./scripts/bundle-data";

/**
 * Copy the three published data files (two backtest results, one signal log) into
 * src/data/bundled before the build reads them, so the deployed artifact carries its
 * own copy and cannot fail to find them at request time. publish.sh also runs the
 * bundler with its freshness check; doing it here as well means any `vite build`
 * path bundles, and a source that cannot be bundled stops the build loudly instead
 * of shipping a site that would have to say "unavailable".
 */
function bundlePublishedData(): Plugin {
  let isBuild = false;
  return {
    name: "meridian-bundle-published-data",
    configResolved(config) {
      isBuild = config.command === "build";
    },
    async buildStart() {
      if (!isBuild) return;
      try {
        const { manifest, warnings } = await bundleData();
        for (const [key, entry] of Object.entries(manifest.entries)) {
          if (!entry) continue;
          this.info(
            `bundled ${key}: ${entry.bundledPath} (${String(entry.bytes)} bytes, sha256 ${entry.sha256.slice(0, 16)}…) from ${entry.sourcePath}`,
          );
        }
        for (const warning of warnings) this.warn(warning);
      } catch (error) {
        this.error(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export default defineConfig({
  server: {
    port: 3000,
    host: true,
    // The site is reverse-proxied behind <label>.<PUBLIC_SITE_DOMAIN>; the proxy
    // masks the Host to localhost:3000, but accept any host so a dev server never
    // rejects a proxied request with "Blocked request".
    allowedHosts: true,
    // The dev server is reachable through the TLS proxy, so the HMR websocket
    // must dial back on 443, not the dev port. If the socket can't connect,
    // pages still serve — hot reload degrades, never breaks.
    hmr: { clientPort: 443 },
    // The dev server can serve source files; never let it serve local secrets,
    // and never let it serve anything outside the site dir. Gotchas this list
    // encodes: a custom `deny` REPLACES Vite's defaults (so .git must be
    // restated), patterns containing "/" match the ABSOLUTE path (so dir
    // patterns need a leading **/), and `allow` left to its default widens to
    // the nearest workspace root — a stray .git or workspaces package.json in
    // /home/team/shared would expose the whole shared dir.
    fs: {
      strict: true,
      allow: [import.meta.dirname],
      deny: [".env", ".env.*", "*.{crt,pem,key}", "**/.run/**", "**/.git/**"],
    },
  },
  plugins: [
    bundlePublishedData(),
    tailwindcss(),
    tsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    tanstackStart(),
    viteReact(),
  ],
});
