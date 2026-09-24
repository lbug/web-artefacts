// Serves the viewer/API and the raw artifact origin on two ports.

import { serve } from "@hono/node-server";
import { createRawApp, createViewerApp, Bus } from "./app.ts";
import { rawOrigin, viewerOrigin, type Config } from "./config.ts";
import { fileBlobs, openSql } from "./storage-node.ts";
import { Store } from "./store.ts";

export async function startServer(cfg: Config): Promise<void> {
  const store = new Store(openSql(cfg.dataDir), fileBlobs(cfg.dataDir));
  const bus = new Bus();

  const listen = (fetch: (req: Request) => Response | Promise<Response>, port: number) =>
    new Promise<void>((resolve, reject) => {
      const server = serve({ fetch, port, hostname: cfg.host }, () => resolve());
      server.once("error", reject);
    });

  await listen(createViewerApp(cfg, store, bus).fetch, cfg.viewerPort);
  await listen(createRawApp(cfg, store).fetch, cfg.rawPort);

  console.log(`web-artefacts
  Viewer: ${viewerOrigin(cfg)}
  Raw:    ${rawOrigin(cfg)}
  MCP:    ${viewerOrigin(cfg)}/mcp
  Data:   ${cfg.dataDir}`);
}
