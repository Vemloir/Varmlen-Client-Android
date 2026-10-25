import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";

/** Identifies the build in Settings: two APKs of one version share a
 *  versionCode, so the commit and build time tell them apart. A `+` after
 *  the commit means the tree had uncommitted changes. */
function buildInfo() {
  /** @param {string} command */
  const git = (command) => {
    try {
      return execSync(`git ${command}`, { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
    } catch {
      return "";
    }
  };
  let versionCode = "";
  try {
    const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
    versionCode = String(conf.bundle?.android?.versionCode ?? "");
  } catch {}
  const commit = git("rev-parse --short HEAD");
  const dirty = commit && git("status --porcelain --untracked-files=no") !== "";
  return {
    versionCode,
    commit: commit ? `${commit}${dirty ? "+" : ""}` : "",
    time: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
  };
}

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [sveltekit()],
  define: {
    __VARMLEN_BUILD__: JSON.stringify(buildInfo()),
  },
  resolve: process.env.VITEST
    ? {
        // Component tests run in a DOM environment and must load Svelte's
        // browser runtime rather than the SSR-only `index-server` export.
        conditions: ["browser"],
      }
    : undefined,

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    // Bind IPv4 explicitly: this host's `localhost` resolves to ::1, whose
    // loopback is broken, so binding default localhost left Vite unreachable
    // and tauri stuck on "Waiting for frontend dev server".
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
