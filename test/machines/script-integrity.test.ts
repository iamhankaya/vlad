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
    const r = await checkEntry(f.dir, f.entry, f.head);
    expect(r.integrity).toBe("ok");
    expect(r.bytes!.toString()).toBe(BODY);
  });
  it("manifest sha256'sı tutmuyor → hash_mismatch", async () => {
    const f = track(scriptRepo("darwin", "x", BODY));
    expect((await checkEntry(f.dir, { ...f.entry, sha256: sha256("başka") }, f.head)).integrity).toBe("hash_mismatch");
  });
  it("betik yalnız çalışma ağacında → not_in_head", async () => {
    const f = track(scriptRepo("darwin", "x", BODY));
    f.write("agent-scripts/y.sh", "echo y");
    expect((await checkEntry(f.dir, entryOf("darwin", "y", "echo y"), f.head)).integrity).toBe("not_in_head");
  });
  it("symlink betik → not_regular", async () => {
    const f = track(scriptRepo("darwin", "x", BODY));
    symlinkIn(f, "agent-scripts/ln.sh", "x.sh");
    const c = f.commit("ln");
    expect((await checkEntry(f.dir, entryOf("darwin", "ln", BODY), c)).integrity).toBe("not_regular");
  });
  it("çalışma ağacındaki içerik değil HEAD blob'u okunur (yerel değişiklik ve CRLF dönüşümü etkilemez)", async () => {
    const f = track(scriptRepo("darwin", "x", BODY));
    f.write("agent-scripts/x.sh", "echo EVIL\r\n");
    const r = await checkEntry(f.dir, f.entry, f.head);
    expect(r.integrity).toBe("ok");
    expect(r.bytes!.toString()).toBe(BODY);
  });
});

describe("checkPushed", () => {
  it("HEAD upstream'de → geçer", async () => {
    const f = track(scriptRepo("darwin", "x", BODY));
    await expect(checkPushed(f.dir, f.head)).resolves.toBeUndefined();
  });
  it("yerel push edilmemiş commit → forbidden [unpushed]", async () => {
    const f = track(scriptRepo("darwin", "x", BODY));
    const local = f.commit("yerel");
    const e = await thrown(checkPushed(f.dir, local));
    expect(e.code).toBe("forbidden");
    expect(e.message).toContain("[unpushed]");
  });
  it("upstream yok → forbidden [no_upstream]", async () => {
    const f = track(makeRepo({ "a": "b" }));
    const e = await thrown(checkPushed(f.dir, f.git("rev-parse", "HEAD").trim()));
    expect(e.code).toBe("forbidden");
    expect(e.message).toContain("[no_upstream]");
  });
  it("özellik dalına itilmiş commit varsayılan dalda değil → forbidden [unpushed]", async () => {
    const f = track(scriptRepo("darwin", "x", BODY));
    f.git("checkout", "-q", "-b", "feat");
    const c = f.commit("özellik");
    f.git("push", "-q", "-u", "origin", "feat");
    const e = await thrown(checkPushed(f.dir, c));
    expect(e.message).toContain("[unpushed]");
    f.git("checkout", "-q", "main");
    await expect(checkPushed(f.dir, f.head)).resolves.toBeUndefined(); // main'e dönünce geçer
    await expect(thrown(checkPushed(f.dir, c))).resolves.toHaveProperty("message", expect.stringContaining("[unpushed]")); // feat commit'i main'de değil
  });
});

describe("tek HEAD oid'i (Codex P1)", () => {
  it("checkEntry verilen commit'ten okur: HEAD sonradan kaysa bile o commit'in baytları ve karması", async () => {
    const f = track(scriptRepo("darwin", "x", BODY));
    f.write("agent-scripts/x.sh", "echo yeni\n");
    f.commit("değişti");
    const old = await checkEntry(f.dir, f.entry, f.head);
    expect(old.integrity).toBe("ok");
    expect(old.bytes!.toString()).toBe(BODY);
    expect((await checkEntry(f.dir, f.entry, f.git("rev-parse", "HEAD").trim())).integrity).toBe("hash_mismatch");
  });
  it("loadRepoState döndürdüğü head'in manifestini okur", async () => {
    const f = track(scriptRepo("darwin", "x", BODY));
    const st = await loadRepoState(f.dir);
    expect(st.head).toBe(f.head);
  });
});
