#!/usr/bin/env node
// web-artefacts CLI - the single entry point for the npm package
// (bundled to dist/cli.js) and for development (node src/cli.ts).

import { spawn } from "node:child_process";

// node:sqlite still prints an ExperimentalWarning on current Node versions.
// Silence exactly that one before anything loads it.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const message = typeof warning === "string" ? warning : warning.message;
  if (/SQLite is an experimental feature|Type Stripping is an experimental feature/.test(message)) return;
  return (emitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const { loadConfig, rawOrigin, viewerOrigin } = await import("./config.ts");
const { ensureService, logFile, serviceUrl, servicePid } = await import("./service.ts");
const { VERSION } = await import("./version.ts");
const cfg = loadConfig();

const HELP = `web-artefacts ${VERSION} – local artifact viewer for coding agents

Usage: web-artefacts <command>

  mcp          MCP server over stdio (for agents; starts the service when needed)
  serve        Run the service in the foreground
  start        Start the service in the background
  stop         Stop the background service
  status       Show whether the service runs, with URLs and data directory
  open [id]    Open the gallery or one artifact in the browser

Setup, e.g. OpenCode:
  opencode mcp add --global web-artefacts -- npx -y web-artefacts mcp

Environment:
  ARTIFACTS_PORT (4400), ARTIFACTS_RAW_PORT (port+1), ARTIFACTS_DATA_DIR,
  ARTIFACTS_AUTOSTART=0 (the "mcp" command never starts the service)`;

function openInBrowser(url: string) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => console.log(url)).unref();
}

const [command = "help", ...args] = process.argv.slice(2);

switch (command) {
  case "mcp": {
    const { runStdio } = await import("../mcp/stdio.ts");
    runStdio(cfg);
    break;
  }
  case "serve": {
    const { startServer } = await import("./server.ts");
    try {
      await startServer(cfg);
    } catch (e) {
      console.error(`web-artefacts: failed to start: ${(e as Error).message}`);
      process.exit(1);
    }
    break;
  }
  case "start": {
    await ensureService(cfg, { autostart: true });
    console.log(`Running: ${serviceUrl(cfg)} (pid ${await servicePid(cfg)})`);
    break;
  }
  case "stop": {
    const pid = await servicePid(cfg);
    if (!pid) {
      console.log("Service is not running.");
      break;
    }
    process.kill(pid);
    console.log(`Stopped (pid ${pid}).`);
    break;
  }
  case "status": {
    const pid = await servicePid(cfg);
    console.log(pid ? `Running (pid ${pid})` : "Not running");
    console.log(`  Viewer: ${viewerOrigin(cfg)}\n  Raw:    ${rawOrigin(cfg)}\n  MCP:    ${viewerOrigin(cfg)}/mcp\n  Data:   ${cfg.dataDir}\n  Log:    ${logFile(cfg)}`);
    break;
  }
  case "open": {
    await ensureService(cfg, { autostart: true });
    const id = args[0]?.match(/[a-z0-9]{4,32}$/)?.[0];
    openInBrowser(id ? `${serviceUrl(cfg)}/a/${id}` : serviceUrl(cfg));
    break;
  }
  case "-v":
  case "--version":
    console.log(VERSION);
    break;
  case "help":
  case "-h":
  case "--help":
    console.log(HELP);
    break;
  default:
    console.error(`Unknown command: ${command}\n\n${HELP}`);
    process.exit(1);
}
