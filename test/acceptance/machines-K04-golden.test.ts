// K4 — `machines` tanımlı değilken (bugünkü tek makineli kurulum) CLI çıktıları TABAN (9211aab, çoklu makine öncesi) ile aynı.
// Golden: test/fixtures/machines-golden/k4.json, taban commit'te şu betikle üretildi (VLAD_GOLDEN_UPDATE=1 + VLAD_GOLDEN_CLI=<taban dist/cli.js>).
// Adım 12 (status --summary) bilinçli olarak güncellendi (T20261103-02, F-vlad-174): T20261102-57 `staleSummaries` + D-vlad-061 `pendingDigest` alanları ve özet satırı eklendi; machines ile ilgisiz.
// Adım 12 yine bilinçli güncellendi (T20261103-13): `kbLint: {count, byCode, at}` alanı eklendi (önbellek yokken boş); kb lint entegrasyonu, machines ile ilgisiz.
// Zaman/ID/yol alanları normalize edilir (takvim tarihi sabitlenemez); geri kalan bayt bayt eşittir. Help metni kapsam dışı (yeni gruplar help'i değiştirir).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rmTemp } from "../helpers.js";
import { CLI } from "../machines/harness.js";
import { git } from "./machines-world.js";

const GOLDEN = resolve(import.meta.dirname, "..", "fixtures", "machines-golden", "k4.json");
const bases: string[] = [];
afterEach(() => { for (const b of bases.splice(0)) rmTemp(b); });

interface Step { cmd: string; code: number | null; out: string; err: string }

function scenario(cli: string): Step[] {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "vlad-k4-")));
  bases.push(base);
  const home = join(base, "home");
  for (const d of ["projects", "tasks", "inbox", "inbox/processed", "logs", "journal"]) mkdirSync(join(home, "kb", d), { recursive: true });
  spawnSync(process.execPath, ["-e", `require("fs").cpSync(${JSON.stringify(resolve(import.meta.dirname, "..", "..", "schemas"))}, ${JSON.stringify(join(home, "schemas"))}, {recursive:true})`]);
  const repo = join(base, "alpha");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "x\n");
  git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "i");
  const env = { ...process.env, VLAD_HOME: home, VLAD_KB_DIR: "", VLAD_LAUNCHER: "noop", VLAD_CLAUDE_JSON: join(base, "claude.json"), CLAUDE_CODE_REMOTE: "" };
  delete (env as Record<string, string | undefined>).VLAD_KB_DIR;
  delete (env as Record<string, string | undefined>).VLAD_MACHINE;
  delete (env as Record<string, string | undefined>).VLAD_LOCAL_FILE;
  const card = join(base, "card.md");
  writeFileSync(card, `---\nslug: alpha\nname: alpha\npath: ${JSON.stringify(repo)}\nstack: [ts]\nstatus: active\nautonomy: commit\nlast_activity: null\nlast_scanned: null\n---\n\n## Özet\nx\n`);
  const norm = (s: string) => s
    .split("\\\\").join("/").split("\\").join("/")
    .split(base.split("\\").join("/")).join("<BASE>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g, "<ISO>")
    .replace(/\bT\d{8}-(\d+)/g, "T<DATE>-$1");
  const steps: Step[] = [];
  const run = (argv: string[], input?: string) => {
    const r = spawnSync(process.execPath, [cli, ...argv], { encoding: "utf8", input, env });
    steps.push({ cmd: norm(argv.join(" ")), code: r.status, out: norm(r.stdout), err: norm(r.stderr) });
    return r;
  };
  run(["project", "write", "alpha", "--file", card, "--json"]);
  const n1 = run(["task", "new", "--project", "alpha", "--title", "Bir", "--kind", "dev", "--body-file", "-", "--json"], "## Tanım\nbir\n");
  const id1 = JSON.parse(n1.stdout).id as string;
  run(["task", "new", "--project", "alpha", "--title", "İki", "--kind", "dev", "--body-file", "-"], "## Tanım\niki\n");
  run(["task", "ready"]);
  run(["task", "ready", "--json"]);
  run(["task", "list"]);
  run(["task", "list", "--json", "--fields", "id,state,title,project"]);
  run(["project", "set", "alpha", "exposure", "network"]);
  run(["project", "list", "--json"]);
  run(["task", "launch", id1, "--dry-run"]);
  run(["task", "list", "--json", "--fields", "id,state,title,branch"]);
  run(["status", "--no-mark"]);
  run(["status", "--summary", "--json", "--no-mark"]);
  run(["task", "log", id1, "not"]);
  run(["task", "ask", id1, "soru?"]);
  run(["task", "answer", id1, "cevap"]);
  return steps;
}

describe("machines:K — K4 machines yokken çıktılar golden ile aynı", () => {
  it.skipIf(!process.env.VLAD_GOLDEN_UPDATE)("(üretim) VLAD_GOLDEN_UPDATE=1 taban CLI ile golden yazar", () => {
    const cli = process.env.VLAD_GOLDEN_CLI;
    if (!cli) throw new Error("VLAD_GOLDEN_CLI gerekli");
    mkdirSync(dirname(GOLDEN), { recursive: true });
    writeFileSync(GOLDEN, JSON.stringify(scenario(cli), null, 2) + "\n");
  });

  it("golden mevcut ve her adım en az bir kontrol içeriyor", () => {
    expect(existsSync(GOLDEN)).toBe(true);
    const g = JSON.parse(readFileSync(GOLDEN, "utf8")) as Step[];
    expect(g.length).toBeGreaterThanOrEqual(15);
    expect(g.filter((s) => s.code === 0).length).toBeGreaterThanOrEqual(10);
  });

  it("şimdiki CLI bayt bayt aynı çıktıyı üretir", () => {
    const g = JSON.parse(readFileSync(GOLDEN, "utf8")) as Step[];
    const now = scenario(CLI);
    expect(now.map((s) => s.cmd)).toEqual(g.map((s) => s.cmd));
    for (let i = 0; i < g.length; i++) expect(now[i], `adım ${i}: ${g[i].cmd}`).toEqual(g[i]);
  }, 120_000);
});
