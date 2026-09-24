// Finding, starting and stopping the background service. Shared by the CLI
// and the stdio MCP server.

import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { viewerOrigin, type Config } from "./config.ts";
import { VERSION } from "./version.ts";

export const serviceUrl = (cfg: Config) => (process.env.ARTIFACTS_URL ?? viewerOrigin(cfg)).replace(/\/$/, "");
export const logFile = (cfg: Config) => join(cfg.dataDir, "server.log");

interface Health {
  pid: number;
  version: string;
}

async function health(cfg: Config): Promise<Health | null> {
  try {
    const res = await fetch(`${serviceUrl(cfg)}/healthz`, { signal: AbortSignal.timeout(1000) });
    const body = res.ok ? await res.json() : null;
    return body?.service === "web-artefacts" ? { pid: body.pid, version: body.version } : null;
  } catch {
    return null;
  }
}

/** Returns the service's pid if it is running, otherwise null. */
export async function servicePid(cfg: Config): Promise<number | null> {
  return (await health(cfg))?.pid ?? null;
}

/** Numeric semver comparison (prerelease tags are ignored). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

let starting: Promise<void> | null = null;

/** Starts the service detached unless it already runs. */
export async function ensureService(cfg: Config, opts: { autostart?: boolean } = {}): Promise<void> {
  const autostart = opts.autostart ?? process.env.ARTIFACTS_AUTOSTART !== "0";
  const running = await health(cfg);
  // A newer or equal version keeps running; only an older one gets replaced,
  // so two agents on different package versions never fight over the port.
  if (running && (!autostart || compareVersions(running.version ?? "0", VERSION) >= 0)) return;
  if (!autostart) throw new Error(`Artifact service not reachable at ${serviceUrl(cfg)}.`);

  starting ??= (async () => {
    // `npx` picked up a newer package than the one the background service
    // was started from: replace it, so the API matches the tools.
    if (running) {
      try {
        process.kill(running.pid);
      } catch {}
      for (let i = 0; i < 30 && (await health(cfg)); i++) await new Promise((r) => setTimeout(r, 100));
    }
    mkdirSync(cfg.dataDir, { recursive: true });
    const log = openSync(logFile(cfg), "a");
    // Re-run the same entry point (src/cli.ts in development, dist/cli.js in
    // the package) with the "serve" command.
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1], "serve"], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", log, log],
      env: process.env,
    });
    child.unref();
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const now = await health(cfg);
      if (now && compareVersions(now.version ?? "0", VERSION) >= 0) return;
    }
    throw new Error(`Artifact service failed to start, see ${logFile(cfg)}`);
  })().finally(() => (starting = null));
  await starting;
}
