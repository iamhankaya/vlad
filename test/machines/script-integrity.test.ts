import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { checkEntry, checkPushed, loadRepoState } from "../../src/agent/scripts/integrity.js";
import { RemoteError } from "../../src/fleet/types.js";
import { entryOf, makeRepo, manifestJson, scriptRepo, sha256, symlinkIn, type Fixture } from "./script-fixture.js";

// Bütünlük algoritması (T20261109-07): çalışma ağacı değil HEAD blob'u esas alınır.

const made: Fixture[] = [];
const track = <T extends Fixture>(f: T): T => { made.push(f); return f; };
afterEach(() => { for (const f of made.splice(0)) rmSync(f.dir, { recursive: true, force: true }); });
const thrown = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as RemoteError; } throw new Error("fırlatmadı"); };

const BODY = "echo hello\n";

describe("loadRepoState", () => {
  it("temiz depo: head, manifest ve dirty=false", async () => {
    const f = track(scriptRepo("darwin", "x", BODY));
    const s = await loadRepoState(f.dir);
    expect(s.head).toBe(f.head);
    expect(s.dirty).toBe(false);
    expect(s.manifest.scripts.map((e) => e.name)).toEqual(["x"]);
  });
  it("agent-scripts altında değişmiş, stage'li ya da izlenmeyen dosya → dirty", async () => {
    for (const mutate of [
      (f: Fixture) => f.write("agent-scripts/x.sh", BODY + "evil\n"),
      (f: Fixture) => { f.write("agent-scripts/y.sh", "x"); f.git("add", "agent-scripts/y.sh"); },
      (f: Fixture) => f.write("agent-scripts/untracked.sh", "x"),
    ]) {
      const f = track(scriptRepo("darwin", "x", BODY));
      mutate(f);
      expect((await loadRepoState(f.dir)).dirty).toBe(true);
    }
  });
  it("agent-scripts dışındaki kirlilik dirty sayılmaz", async () => {
    const f = track(scriptRepo("darwin", "x", BODY));
    f.write("README.md", "yerel not");
    expect((await loadRepoState(f.dir)).dirty).toBe(false);
  });
  it("manifest yalnız çalışma ağacında → forbidden [not_in_head]", async () => {
    const f = track(makeRepo({ "README.md": "x" }));
    f.write("agent-scripts/manifest.json", manifestJson());
    const e = await thrown(loadRepoState(f.dir));
    expect(e.code).toBe("forbidden");
    expect(e.message).toContain("[not_in_head]");
  });
  it("manifest symlink → forbidden [not_regular]", async () => {
    const f = track(makeRepo({ "README.md": "x", "real.json": manifestJson() }));
    symlinkIn(f, "agent-scripts/manifest.json", "../real.json");
    f.commit("link");
    const e = await thrown(loadRepoState(f.dir));
    expect(e.code).toBe("forbidden");
    expect(e.message).toContain("[not_regular]");
  });
  it("bozuk manifest HEAD'de → failed [bad_manifest]", async () => {
    const f = track(makeRepo({ "agent-scripts/manifest.json": "{ yok" }));
    const e = await thrown(loadRepoState(f.dir));
    expect(e.code).toBe("failed");
    expect(e.message).toContain("[bad_manifest]");
  });
  it("64 KiB'ı aşan manifest → failed [bad_manifest]", async () => {
    const f = track(makeRepo({ "agent-scripts/manifest.json": manifestJson(entryOf("darwin", "x", "a")).replace("}\n", `, "pad": "${"a".repeat(70_000)}"}\n`) }));
    const e = await thrown(loadRepoState(f.dir));
    expect(e.message).toContain("[bad_manifest]");
  });
  it("VLAD_HOME deponun kökü değilse → failed [no_repo]", async () => {
    const f = track(scriptRepo("darwin", "x", BODY));
    f.write("sub/.keep", "");
    f.commit("sub");
    const e = await thrown(loadRepoState(`${f.dir}/sub`));
    expect(e.code).toBe("failed");
    expect(e.message).toContain("[no_repo]");
  });
});

describe("checkEntry", () => {
  it("ok: blob baytları döner", async () => {
    const f = track(scriptRepo("darwin", "x", BODY));
    const r = await checkEntry(f.dir, f.entry);
    expect(r.integrity).toBe("ok");
    expect(r.bytes!.toString()).toBe(BODY);
  });
  it("manifest sha256'sı tutmuyor → hash_mismatch", async () => {
    const f = track(scriptRepo("darwin", "x", BODY));
    expect((await checkEntry(f.dir, { ...f.entry, sha256: sha256("başka") })).integrity).toBe("hash_mismatch");
  });
  it("betik yalnız çalışma ağacında → not_in_head", async () => {
    const f = track(scriptRepo("darwin", "x", BODY));
    f.write("agent-scripts/y.sh", "echo y");
    expect((await checkEntry(f.dir, entryOf("darwin", "y", "echo y"))).integrity).toBe("not_in_head");
  });
  it("symlink betik → not_regular", async () => {
    const f = track(scriptRepo("darwin", "x", BODY));
    symlinkIn(f, "agent-scripts/ln.sh", "x.sh");
    f.commit("ln");
    expect((await checkEntry(f.dir, entryOf("darwin", "ln", BODY))).integrity).toBe("not_regular");
  });
  it("çalışma ağacındaki içerik değil HEAD blob'u okunur (yerel değişiklik ve CRLF dönüşümü etkilemez)", async () => {
    const f = track(scriptRepo("darwin", "x", BODY));
    f.write("agent-scripts/x.sh", "echo EVIL\r\n");
    const r = await checkEntry(f.dir, f.entry);
    expect(r.integrity).toBe("ok");
    expect(r.bytes!.toString()).toBe(BODY);
  });
});

describe("checkPushed", () => {
  it("HEAD upstream'de → geçer", async () => {
    const f = track(scriptRepo("darwin", "x", BODY));
    await expect(checkPushed(f.dir)).resolves.toBeUndefined();
  });
  it("yerel push edilmemiş commit → forbidden [unpushed]", async () => {
    const f = track(scriptRepo("darwin", "x", BODY));
    f.commit("yerel");
    const e = await thrown(checkPushed(f.dir));
    expect(e.code).toBe("forbidden");
    expect(e.message).toContain("[unpushed]");
  });
  it("upstream yok → forbidden [no_upstream]", async () => {
    const f = track(makeRepo({ "a": "b" }));
    const e = await thrown(checkPushed(f.dir));
    expect(e.code).toBe("forbidden");
    expect(e.message).toContain("[no_upstream]");
  });
});
