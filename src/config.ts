import { homedir } from "node:os";
import { join } from "node:path";

// Viewer and raw HTML are served on two ports so they are different origins:
// artifact JavaScript can never reach the viewer's API or DOM.
export interface Config {
  host: string;
  viewerPort: number;
  rawPort: number;
  dataDir: string;
}

export function loadConfig(env = process.env): Config {
  const viewerPort = Number(env.ARTIFACTS_PORT ?? 4400);
  return {
    host: env.ARTIFACTS_HOST ?? "127.0.0.1",
    viewerPort,
    rawPort: Number(env.ARTIFACTS_RAW_PORT ?? viewerPort + 1),
    dataDir: env.ARTIFACTS_DATA_DIR ?? join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "web-artefacts"),
  };
}

export const viewerOrigin = (cfg: Config) => `http://${cfg.host}:${cfg.viewerPort}`;
export const rawOrigin = (cfg: Config) => `http://${cfg.host}:${cfg.rawPort}`;
