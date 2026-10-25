// Doğrulama fazı (T20261025-99): faz 1–3'ün birleşik sonucu — model dağıtımı, roller, kısa yazım kuralı,
// uçtan uca `task new --model` → launcher komut satırı. Gerçek CLI (dist/cli.js) + geçici kb kullanır.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/kb/index.js";
import { buildScript } from "../../src/launcher/terminal.js";
import type { LaunchRequest, Launcher } from "../../src/launcher/index.js";
import { launchTask } from "../../src/tasks/launch.js";
import { makeHome } from "../helpers.js";

const root = resolve(import.meta.dirname, "..", "..");
const cli = join(root, "dist", "cli.js");
const read = (p: string) => readFileSync(join(root, p), "utf8");
let home: string;
let repo: string;

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe", encoding: "utf8" });
}
function vlad(args: string[], input?: string) {
  const r = spawnSync("node", [cli, ...args], {
    encoding: "utf8", input, env: { ...process.env, VLAD_HOME: home, CLAUDE_CODE_REMOTE: "" },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function newTask(...extra: string[]) {
  return vlad(["task", "new", "--project", "alpha", "--title", "T", "--kind", "dev", "--body-file", "-", "--json", ...extra], "## Tanım\nx\n");
}

beforeEach(() => {
  home = makeHome();
  cpSync(join(root, "roles"), join(home, "roles"), { recursive: true });
  const base = mkdtempSync(join(tmpdir(), "vlad-mrv-"));
  repo = join(base, "alpha");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "1");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "first");
  writeFileSync(join(home, "card.md"), `---
slug: alpha
name: Alpha
path: ${JSON.stringify(repo)}
stack: [ts]
status: active
autonomy: commit
repo: owner/alpha
last_activity: null
last_scanned: null
---

## Özet
x
`);
  expect(vlad(["project", "write", "alpha", "--file", join(home, "card.md")]).code).toBe(0);
});

describe("model dağıtımı: uçtan uca", () => {
  it("task new --model haiku → launcher isteği ve script'te `claude --model 'haiku'`", async () => {
    const r = newTask("--model", "haiku");
    expect(r.code, r.err).toBe(0);
    const id = JSON.parse(r.out).id as string;
    const reqs: LaunchRequest[] = [];
    const launcher: Launcher = { async launch(q) { reqs.push(q); return { ok: true, method: "fake" }; } };
    const cfg = defaultConfig();
    cfg.worktreeDir = join(mkdtempSync(join(tmpdir(), "vlad-mrv-wt-")), "wt");
    await launchTask(id, { launcher, cfg });
    expect(reqs).toHaveLength(1);
    expect(reqs[0].model).toBe("haiku");
    expect(buildScript(reqs[0])).toMatch(/\nclaude --model 'haiku' \$p\n$/);
  });

  it("görev modeli rolün modelini ezer; list --json effective_model/role_model verir", () => {
    const tester = read("roles/tester.md").match(/^model: (\w+)$/m)![1];
    const a = JSON.parse(newTask("--role", "tester", "--model", "haiku").out).id;
    const b = JSON.parse(newTask("--role", "tester").out).id;
    const list = (JSON.parse(vlad(["task", "list", "--json"]).out) as { tasks: Array<Record<string, unknown>> }).tasks;
    const byId = (id: string) => list.find((t) => t.id === id)!;
    expect(byId(a)).toMatchObject({ model: "haiku", effective_model: "haiku", role_model: tester });
    expect(byId(b)).toMatchObject({ effective_model: tester, role_model: tester });
  });

  it("opus gerekçesiz reddedilir (çıkış 1, stderr JSON, görev oluşmaz); gerekçeyle kabul", () => {
    const bad = newTask("--model", "opus");
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.err).error).toMatch(/model-reason|gerekçe/i);
    expect(JSON.parse(vlad(["task", "list", "--json"]).out).tasks).toHaveLength(0);
    const ok = newTask("--model", "opus", "--model-reason", "kritik karar");
    expect(ok.code, ok.err).toBe(0);
    expect(read("schemas/task.schema.json")).toContain("model_reason");
  });

  it("geçersiz model ve boş model reddedilir", () => {
    expect(newTask("--model", "gpt4").code).toBe(1);
    expect(newTask("--model", "").code).toBe(1);
  });

  it("eski (modelsiz) görev dosyası geçerli kalır: effective_model rol modelinden gelir", () => {
    const id = JSON.parse(newTask("--role", "tester", "--model", "haiku").out).id as string;
    const file = join(home, "kb", "tasks", `${id}.md`);
    writeFileSync(file, readFileSync(file, "utf8").replace(/^model: .*\r?\n/m, ""));
    expect(readFileSync(file, "utf8")).not.toMatch(/^model:/m);
    const list = (JSON.parse(vlad(["task", "list", "--json"]).out) as { tasks: Array<Record<string, unknown>> }).tasks;
    expect(list.find((t) => t.id === id)).toMatchObject({ effective_model: "sonnet", role_model: "sonnet" });
    expect(vlad(["status", "--json"]).code).toBe(0);
  });
});

describe("roller: vlad role list --json", () => {
  it("game-developer, game-director, growth listelenir; uyarı yok; kind'lar CLAUDE.md ile uyumlu", () => {
    const r = vlad(["role", "list", "--json"]);
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out) as { roles: Array<{ slug: string; kind: string; model?: string }>; warnings: string[] };
    expect(j.warnings).toEqual([]);
    const by = Object.fromEntries(j.roles.map((x) => [x.slug, x]));
    expect(by["game-developer"].kind).toBe("executor");
    expect(by["game-director"].kind).toBe("executor");
    expect(by["growth"].kind).toBe("advisory");
    for (const s of ["game-developer", "game-director", "growth"]) expect(by[s].model, s).toBe("sonnet");
  });

  it("growth, game-developer, game-director CLAUDE.md'de anılır; Codex/Gemini görsel kuralı iki oyun rolünde var", () => {
    const claude = read("CLAUDE.md");
    for (const s of ["growth", "game-developer", "game-director"]) expect(claude).toContain(s);
    for (const s of ["game-developer", "game-director"]) {
      const t = read(`roles/${s}.md`);
      expect(t, s).toContain("codex exec");
      expect(t, s).toContain("Gemini");
    }
  });
});

describe("vlad-worker kısa yazım kuralı", () => {
  it("kural var ve kapanış raporu içeriğini (başlık, ID, gerekçe) korur; numaralı adımların arasına girmez", () => {
    const s = read("global/skills/vlad-worker/SKILL.md");
    expect(s).toContain("## Kısa yazım");
    expect(s).toMatch(/kararların gerekçesi/);
    // `## 2. Çalış` ile `## 3.` arasında: numaralı akış bozulmasın.
    expect(s.indexOf("## Kısa yazım")).toBeGreaterThan(s.indexOf("## 2. Çalış"));
    expect(s.indexOf("## Kısa yazım")).toBeLessThan(s.indexOf("## 3. İlerleme kaydı"));
  });
});

describe("dokümanlar: model dağıtımı", () => {
  it("delegate skill'i Model sütunu, Haiku/Opus kuralı ve --model-reason'ı anlatır; CLAUDE.md model sırasını söyler", () => {
    const d = read(".claude/skills/delegate/SKILL.md");
    expect(d).toContain("Model");
    expect(d).toContain("--model-reason");
    expect(d).toMatch(/Haiku/);
    expect(read("CLAUDE.md")).toMatch(/Model dağıtımı/);
  });
});
