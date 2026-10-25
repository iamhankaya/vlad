import { describe, expect, it } from "vitest";
import { chatSandboxProblem, createChatRunner, type FsProbe } from "../../src/chat/wire.ts";

type Ent = { uid: number; mode: number; kind: "file" | "dir" | "socket" | "link" };
const probe = (tree: Record<string, Ent>, real: Record<string, string> = {}): FsProbe => ({
  lstat(p) {
    const e = tree[p];
    if (!e) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return { uid: e.uid, mode: e.mode, isFile: () => e.kind === "file", isDirectory: () => e.kind === "dir", isSocket: () => e.kind === "socket", isSymbolicLink: () => e.kind === "link" };
  },
  realpath(p) {
    if (!tree[p]) throw new Error("ENOENT");
    return real[p] ?? p;
  },
});
const CLIENT = "/usr/local/libexec/vlad/chat-client";
const SOCK = "/run/vlad-chat/turn.sock";
const good = (): Record<string, Ent> => ({
  [CLIENT]: { uid: 0, mode: 0o755, kind: "file" },
  "/usr/local/libexec/vlad": { uid: 0, mode: 0o755, kind: "dir" },
  "/usr/local/libexec": { uid: 0, mode: 0o755, kind: "dir" },
  "/usr/local": { uid: 0, mode: 0o755, kind: "dir" },
  "/usr": { uid: 0, mode: 0o755, kind: "dir" },
  "/": { uid: 0, mode: 0o755, kind: "dir" },
  [SOCK]: { uid: 995, mode: 0o600, kind: "socket" },
});

describe("server: chat sandbox wiring (F-vlad-024)", () => {
  it("server: chat sandbox accepts a root-owned client in root-owned dirs with the socket present", () => {
    expect(chatSandboxProblem(CLIENT, probe(good()), SOCK)).toBeNull();
  });
  it("server: chat sandbox refuses relative, missing, symlinked, user-owned or group-writable client", () => {
    expect(chatSandboxProblem("chat-client", probe(good()), SOCK)).toMatch(/mutlak/);
    expect(chatSandboxProblem("/nope/chat-client", probe(good()), SOCK)).toMatch(/yok/);
    expect(chatSandboxProblem(CLIENT, probe(good(), { [CLIENT]: "/home/x/evil" }), SOCK)).toMatch(/symlink/);
    expect(chatSandboxProblem(CLIENT, probe({ ...good(), [CLIENT]: { uid: 1000, mode: 0o755, kind: "file" } }), SOCK)).toMatch(/root/);
    expect(chatSandboxProblem(CLIENT, probe({ ...good(), [CLIENT]: { uid: 0, mode: 0o775, kind: "file" } }), SOCK)).toMatch(/root/);
    expect(chatSandboxProblem(CLIENT, probe({ ...good(), [CLIENT]: { uid: 0, mode: 0o757, kind: "file" } }), SOCK)).toMatch(/root/);
  });
  it("server: chat sandbox refuses a client under a directory the agent or API user could replace", () => {
    expect(chatSandboxProblem(CLIENT, probe({ ...good(), "/usr/local/libexec/vlad": { uid: 1000, mode: 0o755, kind: "dir" } }), SOCK)).toMatch(/üst dizin/);
    expect(chatSandboxProblem(CLIENT, probe({ ...good(), "/usr/local": { uid: 0, mode: 0o775, kind: "dir" } }), SOCK)).toMatch(/üst dizin/);
  });
  it("server: chat sandbox refuses when the socket is missing or not a socket", () => {
    const t = good(); delete t[SOCK];
    expect(chatSandboxProblem(CLIENT, probe(t), SOCK)).toMatch(/soketi yok/);
    expect(chatSandboxProblem(CLIENT, probe({ ...good(), [SOCK]: { uid: 0, mode: 0o600, kind: "file" } }), SOCK)).toMatch(/soket değil/);
  });
  it("server: no VLAD_CHAT_CLIENT -> no runner, no log (chat routes stay 501)", () => {
    const logs: string[] = [];
    expect(createChatRunner({ env: {}, stateDir: "/x", kbDir: "/y", ledger: { append: () => null }, log: (m) => logs.push(m) })).toBeUndefined();
    expect(logs).toEqual([]);
  });
  it("server: unsafe client -> no runner and a logged reason (fail closed)", () => {
    const logs: string[] = [];
    const r = createChatRunner({ env: { VLAD_CHAT_CLIENT: "/tmp/evil" }, stateDir: "/x", kbDir: "/y", ledger: { append: () => null }, log: (m) => logs.push(m), fs: probe(good()), socketPath: SOCK });
    expect(r).toBeUndefined();
    expect(logs[0]).toMatch(/sohbet kapalı/);
  });
});
