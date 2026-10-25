import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./http/app.ts";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const stateDir = process.env.VLAD_SERVER_STATE_DIR ?? join(homedir(), ".vlad-server");
const app = buildApp({ stateDir, version: pkg.version, trustProxy: process.env.VLAD_SERVER_TRUST_PROXY === "1" ? "loopback" : false, logger: true });
// Loopback only: the public side is Tailscale Funnel, never a direct listener.
await app.listen({ host: process.env.VLAD_SERVER_HOST ?? "127.0.0.1", port: Number(process.env.VLAD_SERVER_PORT ?? 8787) });
