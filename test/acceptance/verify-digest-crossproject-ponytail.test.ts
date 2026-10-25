// Doğrulama fazı (T20261026-05): T20261026-01 (digest kuralı, F-vlad-063, F-vlad-062) ve T20261026-04 (ponytail)
// entegrasyon dalındaki birleşik sonucu. Gerçek CLI (dist/cli.js) + geçici kb ve geçici git depoları kullanır;
// launch süreci sahte launcher ile (gerçek terminal/çalışan açılmaz).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/kb/index.js";
import type { LaunchRequest, Launcher } from "../../src/launcher/index.js";
import { worktreePath } from "../../src/git/git.js";
import { launchTask } from "../../src/tasks/launch.js";
import { makeHome } from "../helpers.js";

const root = resolve(import.meta.dirname, "..", "..");
const cli = join(root, "dist", "cli.js");
const read = (p: string) => readFileSync(join(root, p), "utf8");

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe", encoding: "utf8" });
}
function vlad(home: string, args: string[], input?: string) {
  // CLAUDE_CODE_REMOTE="" keeps the CLI in local mode whatever the host runs in
  const r = spawnSync("node", [cli, ...args], { encoding: "utf8", input, env: { ...process.env, VLAD_HOME: home, CLAUDE_CODE_REMOTE: "" } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const fakeLauncher = (): Launcher => ({ async launch(_q: LaunchRequest) { return { ok: true, method: "fake" }; } });

/** Section of a SKILL.md from `heading` up to the next `## ` heading. */
function section(md: string, heading: RegExp): string {
  const lines = md.split(/\r?\n/);
  const i = lines.findIndex((l) => heading.test(l));
  expect(i, `heading ${heading}`).toBeGreaterThanOrEqual(0);
  const j = lines.findIndex((l, k) => k > i && /^## /.test(l));
  return lines.slice(i, j < 0 ? undefined : j).join("\n");
}

describe("/digest SKILL.md: kullanıcı onayı kuralı (T20261026-01)", () => {
  const md = read(".claude/skills/digest/SKILL.md");

  it("mevcut adım sırası korunur; 3b, 3 ile 4 arasında", () => {
    const heads = [...md.matchAll(/^## (\d+b?)\. /gm)].map((m) => m[1]);
    expect(heads).toEqual(["0", "1", "2", "3", "3b", "4", "4b", "5", "6", "7"]);
  });

  it("adım 1: İlerleme, Sorular ve çatı İlerleme'si okunur", () => {
    const s = section(md, /^## 1\. /);
    expect(s).toContain("## İlerleme");
    expect(s).toContain("## Sorular");
    expect(s).toMatch(/çatının \(`parent`\) `## İlerleme`/);
  });

  it("3b: dört kaynak, bulununca madde açılmaz/fixed-wontfix ve günlükte kaynak", () => {
    const s = section(md, /^## 3b\. /);
    expect(s).toMatch(/İlerleme.*Sorular/);
    expect(s).toContain("Kullanıcıdan beklenenler");
    expect(s).toContain("decisions.md");
    expect(s).toMatch(/sonraki fazların kapanış raporları/);
    expect(s).toMatch(/madde açılmaz/);
    expect(s).toMatch(/`fixed`\/`wontfix`/);
    expect(s).toMatch(/günlükte kaynağıyla/);
  });

  it("3b'deki `vlad finding set ... --by` komutu CLI'da gerçekten var", () => {
    const home = makeHome();
    const r = vlad(home, ["finding", "set", "--help"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("--by");
  });

  it("adım 4: kartı yazmadan 3b uygulanır, yazdıktan sonra doğrulanır; Çalışma notları'na dokunulmaz", () => {
    const s = section(md, /^## 4\. /);
    expect(s).toMatch(/adım 3b/);
    expect(s).toMatch(/\*\*Doğrula:\*\*/);
    expect(s).toContain("## Son aktivite");
    expect(s).toContain("## Açık konular");
    expect(s).toMatch(/`## Çalışma notları`'na \*\*dokunma\*\*/);
  });
});

describe("/status SKILL.md: projeler arası kapı (F-vlad-063)", () => {
  const md = read(".claude/skills/status/SKILL.md");

  it("merge kapısı projeler arası fazı ve integration_worktrees alanını anlatır", () => {
    expect(md).toMatch(/\*\*Projeler arası fazda\*\*/);
    expect(md).toContain("integration_worktrees");
    expect(md).toMatch(/\{project, repo, branch, worktree\}/);
  });

  it("son kapı her projede ayrı doğrulama; cleanup tüm projeleri kapsar", () => {
    expect(md).toMatch(/\*\*her projenin\*\* entegrasyon worktree'sinde/);
    expect(md).toMatch(/vlad task cleanup <çatı-id> --json.*her projedeki entegrasyon worktree/);
  });
});

// Her test onlarca git/CLI alt süreci başlatır; tam suite yükü altında 5 sn varsayılanı kısa kalır (süre eşiği iddiası yok, yalnız zaman aşımı payı).
describe("projeler arası pipeline: launch → list → cleanup (F-vlad-063, uçtan uca)", { timeout: 60_000 }, () => {
  let home: string;
  let alpha: string;
  let beta: string;
  const cfg = defaultConfig();

  function mkRepo(base: string, name: string): string {
    const r = join(base, name);
    mkdirSync(r);
    git(r, "init", "-b", "main");
    writeFileSync(join(r, "a.txt"), "1");
    git(r, "add", ".");
    git(r, "commit", "-m", "first");
    return r;
  }
  function card(slug: string, path: string) {
    writeFileSync(join(home, `${slug}.md`), `---\nslug: ${slug}\nname: ${slug}\npath: ${JSON.stringify(path)}\nstack: [ts]\nstatus: active\nautonomy: commit\nlast_activity: null\nlast_scanned: null\n---\n\n## Özet\nx\n`);
    const r = vlad(home, ["project", "write", slug, "--file", join(home, `${slug}.md`)]);
    expect(r.code, r.err).toBe(0);
  }
  function newTask(args: string[]): string {
    const r = vlad(home, ["task", "new", "--title", "T", "--body-file", "-", "--json", ...args], "## Tanım\nx\n");
    expect(r.code, r.err).toBe(0);
    return JSON.parse(r.out).id as string;
  }
  const list = () => (JSON.parse(vlad(home, ["task", "list", "--json"]).out) as { tasks: Array<Record<string, any>> }).tasks;
  const finish = (id: string) => {
    for (const s of ["awaiting_approval", "done"]) expect(vlad(home, ["task", "set", id, s]).code).toBe(0);
  };

  beforeEach(() => {
    home = makeHome();
    const base = mkdtempSync(join(tmpdir(), "vlad-xp-"));
    alpha = mkRepo(base, "alpha");
    beta = mkRepo(base, "beta");
    card("alpha", alpha);
    card("beta", beta);
    cfg.worktreeDir = "{repo}-wt"; // varsayılan: depo başına klasör
  });

  async function startPipeline(phaseProjects: string[]) {
    const pid = newTask(["--project", "alpha", "--kind", "pipeline"]);
    const phases: string[] = [];
    for (const [i, p] of phaseProjects.entries()) {
      const id = newTask(["--project", p, "--kind", "dev", "--parent", pid, "--phase", i ? "uygulama" : "plan"]);
      await launchTask(id, { launcher: fakeLauncher(), cfg });
      phases.push(id);
    }
    return { pid, phases };
  }

  it("list --json: çatı satırı faz projesinin entegrasyon worktree'sini kendi reposuna göre verir", async () => {
    const { pid } = await startPipeline(["alpha", "beta"]);
    const row = list().find((t) => t.id === pid)!;
    const iw = row.integration_worktrees as Array<{ project: string; repo: string; branch: string; worktree: string }>;
    expect(iw.map((w) => w.project).sort()).toEqual(["alpha", "beta"]);
    const b = iw.find((w) => w.project === "beta")!;
    expect(b).toMatchObject({ repo: beta, branch: `vlad/${pid}`, worktree: worktreePath(cfg, beta, pid) });
    expect(existsSync(b.worktree)).toBe(true);
    expect(git(b.worktree, "branch", "--show-current").trim()).toBe(`vlad/${pid}`);
    // çatı kaydı yalnızca kendi projesindeki worktree'yi tutar; /status'un uyardığı tuzak budur
    expect(row.worktree).toBe(worktreePath(cfg, alpha, pid));
    expect(row.worktree).not.toBe(b.worktree);
  });

  it("faz satırlarında integration_worktrees alanı yoktur (yalnız pipeline satırında)", async () => {
    const { phases } = await startPipeline(["beta"]);
    expect(list().find((t) => t.id === phases[0])).not.toHaveProperty("integration_worktrees");
  });

  it("cleanup: done çatı her iki projedeki entegrasyon worktree'sini kaldırır, dalları korur; ikinci çağrı hata vermez", async () => {
    const { pid, phases } = await startPipeline(["alpha", "beta"]);
    const aw = worktreePath(cfg, alpha, pid);
    const bw = worktreePath(cfg, beta, pid);
    expect(existsSync(aw) && existsSync(bw)).toBe(true);
    for (const f of phases) finish(f);
    finish(pid);
    const r = vlad(home, ["task", "cleanup", pid, "--json"]);
    expect(r.code, r.err).toBe(0);
    expect(existsSync(aw)).toBe(false);
    expect(existsSync(bw)).toBe(false);
    for (const repo of [alpha, beta]) expect(git(repo, "branch", "--list", `vlad/${pid}`)).toContain(`vlad/${pid}`);
    expect(vlad(home, ["task", "cleanup", pid, "--json"]).code).toBe(0);
  });

  it("cleanup: aktif (done olmayan) çatıda reddedilir ve worktree'ler yerinde kalır", async () => {
    const { pid } = await startPipeline(["alpha", "beta"]);
    const r = vlad(home, ["task", "cleanup", pid, "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.err).error).toMatch(/done\/cancelled/);
    expect(existsSync(worktreePath(cfg, beta, pid))).toBe(true);
  });

  it("gerileme: aynı projedeki pipeline tek entegrasyon worktree'si listeler ve cleanup onu kaldırır", async () => {
    const { pid, phases } = await startPipeline(["alpha", "alpha"]);
    const iw = list().find((t) => t.id === pid)!.integration_worktrees as Array<{ project: string }>;
    expect(iw.map((w) => w.project)).toEqual(["alpha"]);
    for (const f of phases) finish(f);
    finish(pid);
    expect(vlad(home, ["task", "cleanup", pid]).code).toBe(0);
    expect(existsSync(worktreePath(cfg, alpha, pid))).toBe(false);
    expect(existsSync(beta)).toBe(true);
  });

  it("faz projesinin kartı silinirse list --json ve cleanup kırılmaz", async () => {
    const { pid, phases } = await startPipeline(["alpha", "beta"]);
    rmSync(join(home, "kb", "projects", "beta.md"));
    const l = vlad(home, ["task", "list", "--json"]);
    expect(l.code, l.err).toBe(0);
    for (const f of phases) finish(f);
    finish(pid);
    expect(vlad(home, ["task", "cleanup", pid]).code).toBe(0);
    expect(existsSync(worktreePath(cfg, alpha, pid))).toBe(false);
  });
});

describe("F-vlad-062: bulut testleri Windows'ta gerçek terminal açmaz", () => {
  it("test/cloud/cli.test.ts ve cloud-verify3 test evine launcher=cloud yazar", () => {
    for (const f of ["test/cloud/cli.test.ts", "test/acceptance/cloud-verify3.test.ts"]) {
      expect(read(f), f).toMatch(/launcher:\s*"cloud"/);
    }
  });
});

describe("ponytail (T20261026-04)", () => {
  it("SKILL.md blob SHA'sı SOURCE.md ile aynı (kaynakla birebir); LICENSE MIT; başka ponytail dosyası yok", () => {
    const dir = join(root, "vendor", "skills", "ponytail");
    const sha = execFileSync("git", ["hash-object", join(dir, "SKILL.md")], { encoding: "utf8" }).trim();
    expect(read("vendor/skills/ponytail/SOURCE.md")).toContain(sha);
    expect(read("vendor/skills/ponytail/LICENSE")).toMatch(/MIT License/);
    expect(execFileSync("git", ["ls-files", "--", "vendor/skills/ponytail"], { cwd: root, encoding: "utf8" }).trim().split(/\r?\n/).sort())
      .toEqual(["vendor/skills/ponytail/LICENSE", "vendor/skills/ponytail/SKILL.md", "vendor/skills/ponytail/SOURCE.md"]);
  });

  it("vlad role list --json: ponytail yalnız developer ve game-developer skills'inde", () => {
    const r = vlad(root, ["role", "list", "--json"]);
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out) as { roles: Array<{ slug: string; skills: string[] }>; warnings: string[] };
    expect(j.warnings).toEqual([]);
    expect(j.roles.filter((x) => x.skills.includes("ponytail")).map((x) => x.slug).sort()).toEqual(["developer", "game-developer"]);
  });

  it("iki rolde de TDD ve gate önceliği, yalnız full seviye ve kapsam itirazı vlad task ask ile", () => {
    for (const f of ["roles/developer.md", "roles/game-developer.md"]) {
      const line = read(f).split(/\r?\n/).find((l) => l.includes("**ponytail (deneme):**"))!;
      expect(line, f).toBeTruthy();
      expect(line, f).toMatch(/yalnız `full` seviyede/);
      expect(line, f).toMatch(/TDD/);
      expect(line, f).toMatch(/gate/);
      expect(line, f).toMatch(/vlad task ask/);
    }
  });
});
