// stdio MCP server. Serves protocol 2026-07-28 and 2025-era clients alike.
// If the artifact service is not running yet, it is started in the
// background (ARTIFACTS_AUTOSTART=0 disables that).

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { ensureService, serviceUrl } from "../src/service.ts";
import type { Config } from "../src/config.ts";
import { createMcpServer } from "./tools.ts";

/**
 * The project the agent works in: the name of the enclosing git repository,
 * else of the working directory. Undefined for the home or root directory,
 * where agents without a project (e.g. desktop apps) start. The home
 * directory never counts as a repository (dotfiles repos).
 */
export function projectName(cwd: string): string | undefined {
  for (let dir = cwd; dir !== homedir(); dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return basename(dir);
    if (dirname(dir) === dir) break;
  }
  return cwd === homedir() || dirname(cwd) === cwd ? undefined : basename(cwd);
}

export function runStdio(cfg: Config): void {
  const baseUrl = serviceUrl(cfg);
  const cwd = process.cwd();
  const project = projectName(cwd);
  serveStdio(() =>
    createMcpServer({
      cwd,
      project,
      fetchApi: async (path, init) => {
        await ensureService(cfg);
        return fetch(`${baseUrl}${path}`, init);
      },
    }),
  );
}
