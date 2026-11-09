import { spawnGuarded } from "../support/spawn-vlad.js";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rmTemp } from "../helpers.js";
import { RECORD_CLI, makeHomePair, spawnVlad, startProxy, type Proxy } from "./harness.js";
import { isolatedEnv } from "../isolate-env.js";

const bases: string[] = [];
afterEach(() => { for (const b of bases.splice(0)) rmTemp(b); });
const pair = () => {
  const p = makeHomePair({ consoles: ["desktop"] });
  bases.push(dirname(p.brain.home));
  return p;
};

describe("machines:S harness", () => {
  it("makeHomePair does not touch process.env and builds two separate homes", () => {
    const before = { home: process.env.VLAD_HOME, local: process.env.VLAD_LOCAL_FILE, cj: process.env.VLAD_CLAUDE_JSON };
    const p = pair();
    expect({ home: process.env.VLAD_HOME, local: process.env.VLAD_LOCAL_FILE, cj: process.env.VLAD_CLAUDE_JSON }).toEqual(before);
    expect(p.brain.home).not.toBe(p.worker.home);
    for (const s of [p.brain, p.worker]) {
      expect(existsSync(join(s.kb, "tasks"))).toBe(true);
      expect(existsSync(join(s.home, "schemas", "task.schema.json"))).toBe(true);
    }
    expect(p.brain.env.VLAD_CLAUDE_JSON).not.toBe(p.worker.env.VLAD_CLAUDE_JSON);
  });
  it("pair keys: the brain holds every pair; the worker and a console only the one shared with the brain (+ own local key); keys are 64 hex", () => {
    const p = pair();
    expect(Object.keys(p.keys).sort()).toEqual(["desktop", "mac", "windows"]);
    for (const k of [...Object.values(p.keys), p.workerSelfKey]) expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(JSON.parse(readFileSync(p.brain.local, "utf8")).keys).sort()).toEqual(["desktop", "mac", "windows"]);
    expect(JSON.parse(readFileSync(p.worker.local, "utf8"))).toEqual({ self: "windows", keys: { windows: p.workerSelfKey, mac: p.keys.windows } });
    expect(JSON.parse(readFileSync(p.consoleLocal("desktop"), "utf8"))).toEqual({ self: "desktop", keys: { mac: p.keys.desktop } });
    expect(new Set([p.keys.mac, p.keys.windows, p.keys.desktop, p.workerSelfKey]).size).toBe(4); // çiftler birbirinden ayrı
  });
  it("two homes do not leak into each other through spawnVlad", () => {
    const p = pair();
    expect(spawnVlad(p.brain, ["session", "register", "brain-only"]).code).toBe(0);
    expect(spawnVlad(p.brain, ["session", "name"]).out.trim()).toBe("brain-only");
    expect(spawnVlad(p.worker, ["session", "name"]).code).toBe(1);
  });
  it("the recorder CLI appends argv + stdin as one JSONL line and honors exit/stdout env", () => {
    const p = pair();
    const file = join(p.brain.home, "rec.jsonl");
    const r = spawnGuarded(process.execPath, [RECORD_CLI, "task", "log", "T1", "a b"], {
      input: "içerik", encoding: "utf8",
      env: { ...isolatedEnv(), VLAD_RECORD_FILE: file, VLAD_RECORD_STDOUT: "tamam", VLAD_RECORD_EXIT: "3", VLAD_FORWARDED: "windows" },
    });
    expect(r.status).toBe(3);
    expect(r.stdout).toBe("tamam");
    expect(JSON.parse(readFileSync(file, "utf8").trim())).toEqual({ argv: ["task", "log", "T1", "a b"], stdin: "içerik", env: { VLAD_FORWARDED: "windows", VLAD_OP_ID: null } });
  });
});

describe("machines:S proxy", () => {
  const servers: net.Server[] = [];
  const proxies: Proxy[] = [];
  afterEach(async () => { for (const x of proxies.splice(0)) await x.stop(); for (const s of servers.splice(0)) s.close(); });
  const echo = async () => {
    const s = net.createServer((c) => c.on("data", (d) => c.write(d)));
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    return (s.address() as net.AddressInfo).port;
  };
  const roundTrip = (port: number) => new Promise<string>((res) => {
    const c = net.connect(port, "127.0.0.1");
    let got = "";
    c.on("data", (d) => { got += d; res(got); c.destroy(); });
    c.on("error", () => res("ERR"));
    c.on("close", () => res(got || "CLOSED"));
    c.on("connect", () => c.write("ping"));
  });
  it("forwards, counts connections, goes down and up, drops one response", async () => {
    const px = await startProxy({ port: await echo() });
    proxies.push(px);
    expect(await roundTrip(px.port)).toBe("ping");
    expect(px.count).toBe(1);
    px.dropResponse(1); // the next connection's response is lost
    expect(await roundTrip(px.port)).toBe("CLOSED");
    expect(await roundTrip(px.port)).toBe("ping");
    px.down();
    expect(await roundTrip(px.port)).not.toBe("ping");
    px.up();
    expect(await roundTrip(px.port)).toBe("ping");
  });
});
