import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupMadeDirs, makeHome } from "../helpers.js";

// F-vlad-230: buildAktarim, createProdDeps'in xfer'ine clipImage (= clip alıcısının sink'i) bağlamalı.
const seen: Array<{ clipImage?: unknown }> = [];
vi.mock("../../src/transfer/receive.js", async (orig) => {
  const m = await orig<typeof import("../../src/transfer/receive.js")>();
  return { ...m, createXferReceiver: (d: { clipImage?: unknown }) => { seen.push(d); return m.createXferReceiver(d as never); } };
});

let prev: string | undefined, prevNative: string | undefined, prevMachine: string | undefined, prevKb: string | undefined;
beforeEach(() => {
  seen.length = 0;
  prev = process.env.VLAD_HOME; prevKb = process.env.VLAD_KB_DIR; prevNative = process.env.VLAD_NO_NATIVE; prevMachine = process.env.VLAD_MACHINE;
  makeHome(); process.env.VLAD_NO_NATIVE = "1"; process.env.VLAD_MACHINE = "wire-test"; // temp VLAD_HOME; gerçek pano/bildirim yok
});
afterEach(() => {
  if (prev === undefined) delete process.env.VLAD_HOME; else process.env.VLAD_HOME = prev;
  if (prevKb === undefined) delete process.env.VLAD_KB_DIR; else process.env.VLAD_KB_DIR = prevKb;
  if (prevNative === undefined) delete process.env.VLAD_NO_NATIVE; else process.env.VLAD_NO_NATIVE = prevNative;
  if (prevMachine === undefined) delete process.env.VLAD_MACHINE; else process.env.VLAD_MACHINE = prevMachine;
  cleanupMadeDirs();
});

describe("aktarim:V üretim bağlaması", () => {
  it("createProdDeps → buildAktarim: xfer alıcısına clip.sink verilir", async () => {
    const { createProdDeps } = await import("../../src/transfer/deps.js");
    const { buildAktarim } = await import("../../src/agent/ops/index.js");
    const { createClipReceiver } = await import("../../src/clip/receive.js");
    const deps = createProdDeps();
    expect(deps.xfer.clipImage).toBeUndefined();
    const b = buildAktarim(deps);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.clipImage).toBe(createClipReceiver(deps.clip).sink);
    await b.close();
  });
  it("açıkça verilen xfer.clipImage ezilmez", async () => {
    const { createProdDeps } = await import("../../src/transfer/deps.js");
    const { buildAktarim } = await import("../../src/agent/ops/index.js");
    const deps = createProdDeps();
    const own = { enabled: () => true, apply: async () => "applied" as const };
    const b = buildAktarim({ ...deps, xfer: { ...deps.xfer, clipImage: own } });
    expect(seen[0]!.clipImage).toBe(own);
    await b.close();
  });
});
