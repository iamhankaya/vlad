import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { AgentClient } from "../../src/agent/client.js";
import { Journal } from "../../src/agent/journal.js";
import { buildAktarim } from "../../src/agent/ops/index.js";
import { startServer, type RunningServer } from "../../src/agent/server.js";
import { createClipReceiver } from "../../src/clip/receive.js";
import type { ClipboardBackend, ClipContent, ClipDeps, ClipReceiver } from "../../src/clip/types.js";
import { defaultConfig } from "../../src/kb/config.js";
import type { VladConfig } from "../../src/kb/types.js";
import type { Os, RemoteTransport } from "../../src/fleet/types.js";
import type { Notifier } from "../../src/platform/notify.js";
import { uploadBuffer } from "../../src/transfer/send.js";
import type { AktarimDeps, XferFs, XferReceiver, XferTestHooks } from "../../src/transfer/types.js";
import { rmTemp } from "../helpers.js";
import { makeHomePair, startProxy, type Proxy } from "../machines/harness.js";

// Aktarım testlerinin ortak yardımcıları (sözleşme fazı S; sonra yalnız S ekler, ortak ihtiyaç için `vlad task ask`).
// Gerçek pano/bildirim/yardımcı süreç yok (nativeAllowed() = false); İndirilenler her zaman temp.

export class FakeNotifier implements Notifier {
  readonly calls: { title: string; body: string }[] = [];
  private fail = 0;
  failNext(): void { this.fail++; }
  async notify(title: string, body: string): Promise<void> {
    if (this.fail > 0) { this.fail--; throw new Error("sahte bildirim hatası"); }
    this.calls.push({ title, body });
  }
}

/** Sürümlü sahte pano. `setLocal` yerel kullanıcı değişikliğidir (seq +1). */
export class FakeClipboard implements ClipboardBackend {
  readonly writes: ClipContent[] = [];
  reads = 0;
  private seq = 1;
  private content: ClipContent | null = null;
  constructor(private o: { bumpPerWrite?: 1 | 2; transformOnWrite?: (c: ClipContent) => ClipContent; readDelay?: number } = {}) {}
  setLocal(c: ClipContent | null): void { this.content = c; this.seq++; }
  async read() {
    this.reads++;
    if (this.o.readDelay) await new Promise((r) => setTimeout(r, this.o.readDelay));
    return { seq: this.seq, content: this.content };
  }
  async write(c: ClipContent, expectSeq: number) {
    if (expectSeq !== this.seq) return { written: false, seqAfter: this.seq, reason: "local_changed" as const };
    this.content = this.o.transformOnWrite ? this.o.transformOnWrite(c) : c;
    this.writes.push(c);
    this.seq += this.o.bumpPerWrite ?? 1;
    return { written: true, seqAfter: this.seq };
  }
  async changeCount() { return this.seq; }
  async close() {}
}

export interface SideOpts { downloads?: string; clipboard?: FakeClipboard; notifier?: FakeNotifier; clipEnabled?: boolean; hooks?: XferTestHooks; now?: () => number; fs?: Partial<XferFs> }
export interface PairSide {
  name: "mac" | "windows"; role: "brain" | "worker"; port: number; downloads: string; stateDir: string;
  clipboard: FakeClipboard; notifier: FakeNotifier; xfer: XferReceiver; clip: ClipReceiver;
  /** bu taraftan karşıya imzalı AgentClient */
  transport: RemoteTransport;
}
export interface AktarimPair {
  mac: PairSide; windows: PairSide;
  /** `from` tarafının karşıya giden trafiğini vekilden geçirir (dropResponse/gecikme). Hedef yeniden başlarsa yeniden çağır. */
  viaProxy(from: "mac" | "windows"): Promise<Proxy>;
  /** Sunucuyu kapatıp aynı diskten yeni alıcı kurar (bellek kaybı modeli); port değişir. */
  restartAgent(side: "mac" | "windows"): Promise<void>;
  stop(): Promise<void>;
}

type Name = "mac" | "windows";
interface Internal { opts: SideOpts; srv?: RunningServer; keys: Record<string, string>; cfg: VladConfig; journalFile: string; close?: () => Promise<void>; side: PairSide }

export async function startAktarimPair(o: { mac?: SideOpts; windows?: SideOpts; config?: object } = {}): Promise<AktarimPair> {
  const homes = makeHomePair();
  const base = mkdtempSync(join(tmpdir(), "vlad-akt-"));
  const proxies: Proxy[] = [];
  const names: Name[] = ["mac", "windows"];
  const mk = (name: Name): Internal => {
    const opts = o[name] ?? {};
    const dir = join(base, name);
    const downloads = opts.downloads ?? join(dir, "Downloads");
    const stateDir = join(dir, "state");
    mkdirSync(downloads, { recursive: true }); mkdirSync(stateDir, { recursive: true });
    const cfg: VladConfig = {
      ...defaultConfig(), brain: "mac", ...(o.config ?? {}),
      machines: [{ name: "mac", os: "darwin", agent: { host: "127.0.0.1", port: 1 } }, { name: "windows", os: "win32", agent: { host: "127.0.0.1", port: 1 } }],
    };
    const keys = name === "mac" ? { ...homes.keys } : { windows: homes.workerSelfKey, mac: homes.keys.windows! };
    const transport = new AgentClient({ self: name, keys, config: () => cfg });
    const side = { name, role: name === "mac" ? "brain" : "worker", port: 0, downloads, stateDir, clipboard: opts.clipboard ?? new FakeClipboard(), notifier: opts.notifier ?? new FakeNotifier(), transport } as PairSide;
    return { opts, keys, cfg, journalFile: join(stateDir, "journal.jsonl"), side };
  };
  const sides: Record<Name, Internal> = { mac: mk("mac"), windows: mk("windows") };
  const setPorts = () => { for (const n of names) for (const m of sides[n].cfg.machines!) m.agent.port = sides[m.name as Name].side.port; };

  const boot = async (n: Name) => {
    const s = sides[n], peer: Name = n === "mac" ? "windows" : "mac";
    const now = s.opts.now ?? (() => Date.now());
    const kind = n === "mac" ? "brain-agent" : "worker-agent";
    const journal = new Journal(s.journalFile, now);
    const env = () => ({ self: n, kind, cfg: s.cfg, startedAt: now() - 1000, build: "t", journal, transport: s.side.transport, now }) as ReturnType<AktarimDeps["env"]>;
    const send: ClipDeps["send"] = {
      pushText: async (a) => (await s.side.transport.call<"applied" | "stale" | "disabled">(peer, "clip-push", a)).result,
      pushImage: async (png, meta) => (await uploadBuffer(s.side.transport, peer, png, { purpose: "clip-image", name: "clip.png", meta })).clip ?? "invalid",
    };
    const clipDeps: ClipDeps = { backend: s.side.clipboard, send, now, isEnabled: () => s.opts.clipEnabled ?? true, log: () => {}, rank: n === "mac" ? 1 : 0, peer, autoStart: false };
    const os: Os = n === "mac" ? "darwin" : "win32";
    const deps: AktarimDeps = {
      self: n, kind, cfg: () => s.cfg, now, env,
      xfer: { downloads: () => s.side.downloads, stateDir: () => s.side.stateDir, os, notifier: s.side.notifier, now, hooks: s.opts.hooks, fs: s.opts.fs, idleTimers: false },
      clip: clipDeps,
    };
    const ak = buildAktarim(deps);
    const o4 = ak.ops;
    s.side.xfer = { ops: { "xfer-begin": o4["xfer-begin"], "xfer-chunk": o4["xfer-chunk"], "xfer-commit": o4["xfer-commit"], "xfer-abort": o4["xfer-abort"] }, sweep: ak.sweep, close: ak.close };
    s.side.clip = createClipReceiver(clipDeps);
    s.close = ak.close;
    s.srv = await startServer({ self: n, kind, cfg: () => s.cfg, keys: s.keys, ops: ak.ops, journal, build: "t", bind: "127.0.0.1", port: 0 });
    s.side.port = s.srv.port;
    setPorts();
  };
  await boot("mac"); await boot("windows");

  return {
    mac: sides.mac.side, windows: sides.windows.side,
    async viaProxy(from) {
      const to: Name = from === "mac" ? "windows" : "mac";
      const p = await startProxy({ port: sides[to].side.port });
      proxies.push(p);
      sides[from].cfg.machines!.find((x) => x.name === to)!.agent.port = p.port;
      return p;
    },
    async restartAgent(n) {
      const s = sides[n];
      await s.srv?.close(); await s.close?.();
      await boot(n);
    },
    async stop() {
      for (const p of proxies) await p.stop();
      for (const n of names) { await sides[n].srv?.close(); await sides[n].close?.(); }
      homes.cleanup(); rmTemp(base);
    },
  };
}

/** Deterministik içerik (seed + konum); büyük dosyalar için de ucuz. */
export function makeFile(dir: string, name: string, size: number, seed: number): string {
  const f = join(dir, name);
  mkdirSync(dirname(f), { recursive: true });
  const buf = Buffer.alloc(size);
  let x = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < size; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; buf[i] = x & 0xff; }
  writeFileSync(f, buf);
  return f;
}

/** Dizin ağacının içerik özeti: göreli yol + tür + bayt özeti (symlink'ler hedef metniyle). */
export function treeHash(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const e of readdirSync(d).sort()) {
      const p = join(d, e), st = lstatSync(p), rel = relative(dir, p);
      if (st.isSymbolicLink()) h.update(`l:${rel}:${readlinkSync(p)}\n`);
      else if (st.isDirectory()) { h.update(`d:${rel}\n`); walk(p); }
      else h.update(`f:${rel}:${createHash("sha256").update(readFileSync(p)).digest("hex")}\n`);
    }
  };
  walk(dir);
  return h.digest("hex");
}
