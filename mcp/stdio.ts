// stdio MCP server. Serves protocol 2026-07-28 and 2025-era clients alike.
// If the artifact service is not running yet, it is started in the
// background (ARTIFACTS_AUTOSTART=0 disables that).

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { ensureService, serviceUrl } from "../src/service.ts";
import type { Config } from "../src/config.ts";
import { createMcpServer } from "./tools.ts";

export function runStdio(cfg: Config): void {
  const baseUrl = serviceUrl(cfg);
  serveStdio(() =>
    createMcpServer({
      cwd: process.cwd(),
      fetchApi: async (path, init) => {
        await ensureService(cfg);
        return fetch(`${baseUrl}${path}`, init);
      },
    }),
  );
}
