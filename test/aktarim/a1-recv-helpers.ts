import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createXferReceiver } from "../../src/transfer/receive.js";
import type { ClipImageSink, XferBeginArgs, XferBeginResult, XferChunkResult, XferCommitResult, XferDeps, XferEntry, XferReceiver } from "../../src/transfer/types.js";
import type { Os } from "../../src/fleet/types.js";
import { rmTemp } from "../helpers.js";
import { FakeNotifier } from "./harness.js";

export const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
export const newId = () => randomBytes(16).toString("hex");
export const FROM = "mac";

export interface Rig {
  base: string; downloads: string; stateDir: string; notifier: FakeNotifier; rx: XferReceiver; clock: { t: number };
  deps: XferDeps;
  call<T = unknown>(op: "xfer-begin" | "xfer-chunk" | "xfer-commit" | "xfer-abort", args: unknown, from?: string): Promise<T>;
  begin(id: string, entries: XferEntry[], extra?: Partial<XferBeginArgs>, from?: string): Promise<XferBeginResult>;
  chunk(id: string, entry: number, offset: number, data: Buffer, from?: string): Promise<XferChunkResult>;
  commit(id: string, sha256: (string | null)[], from?: string): Promise<XferCommitResult>;
  /** tek dosyayı baştan sona gönderir */
  put(id: string, name: string, data: Buffer, from?: string): Promise<XferCommitResult>;
  restart(): Promise<void>;
  staging(): string[];
  cleanup(): void;
}

export function makeRig(o: { os?: Os; deps?: Partial<XferDeps>; clipImage?: ClipImageSink } = {}): Rig {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "vlad-a1r-")));
  const downloads = join(base, "Downloads"), stateDir = join(base, "state");
  mkdirSync(downloads); mkdirSync(stateDir);
  const notifier = new FakeNotifier();
  const clock = { t: 1_800_000_000_000 };
  const deps: XferDeps = { downloads: () => downloads, stateDir: () => stateDir, os: o.os ?? "darwin", notifier, now: () => clock.t, idleTimers: false, clipImage: o.clipImage, ...o.deps };
  const rig: Rig = {
    base, downloads, stateDir, notifier, clock, deps, rx: createXferReceiver(deps),
    call: (op, args, from = FROM) => rig.rx.ops[op](args, { from, opId: "x" }) as Promise<never>,
    begin: (id, entries, extra = {}, from) => rig.call("xfer-begin", { id, purpose: "file", entries, ...extra }, from),
    chunk: (id, entry, offset, data, from) => rig.call("xfer-chunk", { id, entry, offset, data: data.toString("base64") }, from),
    commit: (id, sha256, from) => rig.call("xfer-commit", { id, sha256 }, from),
    async put(id, name, data, from) {
      await rig.begin(id, [{ path: name, kind: "file", size: data.length }], {}, from);
      if (data.length) await rig.chunk(id, 0, 0, data, from);
      return rig.commit(id, [sha(data)], from);
    },
    async restart() { await rig.rx.close(); rig.rx = createXferReceiver(deps); },
    staging: () => { try { return readdirSync(join(downloads, ".vlad-incoming")); } catch { return []; } },
    cleanup: () => { void rig.rx.close(); rmTemp(base); },
  };
  return rig;
}
