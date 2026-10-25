import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readVault, searchVault } from "../../src/vault/search.js";
import { makeHome } from "../helpers.js";

// S5x B1: a folder swapped for a link while a search walks must never make forbidden content come back.
// The swapper is a separate process (a loop in this one could not interleave with the synchronous walk).
const SECRET = "GIZLI-YARIS-ICERIK-4417";
let home: string;
let kb: string;
let swapper: ChildProcess | null = null;

const SWAP = `
const { renameSync, symlinkSync } = require("node:fs");
const [dir, target] = process.argv.slice(1);
symlinkSync(target, dir + ".lnk");
let link = false;
setInterval(() => {}, 1 << 30);
(function loop() {
  try {
    if (!link) { renameSync(dir, dir + ".real"); renameSync(dir + ".lnk", dir); }
    else { renameSync(dir, dir + ".lnk"); renameSync(dir + ".real", dir); }
    link = !link;
  } catch {}
  setImmediate(loop);
})();
`;

beforeEach(() => {
  home = makeHome();
  kb = mkdtempSync(join(tmpdir(), "vlad-race-"));
  process.env.VLAD_KB_DIR = kb;
  for (const d of ["projects", "grants", "audit", "inbox", "docs/a"]) mkdirSync(join(kb, d), { recursive: true });
  for (const f of ["grants/G-001.md", "grants/G-002.md", "audit/2026-10.md", "inbox/r.md"]) writeFileSync(join(kb, f), `# gizli\n${SECRET}\n`);
  writeFileSync(join(kb, "docs/a/ok.md"), "# ok\nzararsiz\n");
  // many files after the swapped folder widen the gap between "listed as a folder" and "descended into"
  for (let i = 0; i < 400; i++) writeFileSync(join(kb, "docs", `f${String(i).padStart(3, "0")}.md`), "x".repeat(2000));
  mkdirSync(join(kb, "projects/a"));
  writeFileSync(join(kb, "projects/a/ok.md"), "# ok\n");
  for (let i = 0; i < 400; i++) writeFileSync(join(kb, "projects", `f${String(i).padStart(3, "0")}.md`), "x".repeat(2000));
});
afterEach(() => {
  swapper?.kill("SIGKILL");
  swapper = null;
  delete process.env.VLAD_KB_DIR;
  rmSync(kb, { recursive: true, force: true });
});

const startSwapper = async (dir: string, target: string) => {
  swapper = spawn(process.execPath, ["-e", SWAP, dir, target], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 300));
};

describe("records: vault walk race (S5x B1)", () => {
  for (const [name, dir, target] of [
    ["kb folder swapped for a link to grants", "projects/a", "grants"],
    ["kb folder swapped for a link to audit", "projects/a", "audit"],
    ["docs folder swapped for a link to inbox", "docs/a", "inbox"],
  ] as const) {
    it(`records: vault search race: ${name} never returns forbidden content`, async () => {
      await startSwapper(join(kb, dir), join(kb, target));
      const leaks: string[] = [];
      for (let i = 0; i < 40; i++) {
        for (const h of searchVault(SECRET).hits) leaks.push(h.path);
        for (const h of searchVault("x".repeat(30)).hits.filter((x) => /gizli|G-00|2026-10|r\.md/.test(x.path))) leaks.push(h.path);
      }
      expect(leaks).toEqual([]);
    });
  }

  it("records: vault read race: a folder swapped for a link never returns forbidden content", async () => {
    await startSwapper(join(kb, "projects/a"), join(kb, "grants"));
    const leaked: string[] = [];
    for (let i = 0; i < 400; i++) {
      for (const name of ["ok.md", "G-001.md"]) {
        try {
          const c = readVault(`kb/projects/a/${name}`).content;
          if (c.includes(SECRET)) leaked.push(name);
        } catch {
          /* refused or missing while swapped: fine */
        }
      }
    }
    expect(leaked).toEqual([]);
  });
});

describe("records: vault verifyOpened (S5x B1)", () => {
  it("records: vault read of a file whose parent is a link into a forbidden folder is refused", () => {
    symlinkSync(join(kb, "grants"), join(kb, "projects/glink"));
    expect(() => readVault("kb/projects/glink/G-001.md")).toThrow(/izin listesinde değil/);
  });
});
