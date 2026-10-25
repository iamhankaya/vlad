// T20261024-109 (T1) kabul testleri için ortak yardımcılar.
// Testler docs/plan/vlad-mobile-plan.md arayüzlerinden yazıldı; CLI yalnız `dist/cli.js` alt süreci ile sınanır.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { makeHome } from "../../helpers.js";
import { NO_CLOUD_ENV, cli, tmp, vlad } from "../cloud-helpers.js";

export { tmp };
export const MACHINE = "t1box";

type Env = Record<string, string | undefined>;
export type Run = { code: number | null; out: string; err: string };

/** CLI'ı bulut işaretleri kaldırılmış, makine adı sabit olarak koşar. */
export function run(home: string, args: string[], o: { input?: string; env?: Env } = {}): Run {
  return vlad(home, args, { input: o.input, env: { ...NO_CLOUD_ENV, VLAD_MACHINE: MACHINE, ...o.env } });
}

/** Başarılı --json çağrısı; stdout JSON döner. */
export function ok<T = any>(home: string, args: string[], o: { input?: string; env?: Env } = {}): T {
  const r = run(home, [...args, "--json"], o);
  expect(r.code, `${args.join(" ")}\n${r.err}`).toBe(0);
  return JSON.parse(r.out) as T;
}

/** Hata sözleşmesi: çıkış 1, stderr `{"error": <metin>, "details": [...]}`. Hata nesnesini döner. */
export function fail(home: string, args: string[], o: { input?: string; env?: Env } = {}): { error: string; details: unknown[] } {
  const r = run(home, [...args, "--json"], o);
  expect(r.code, `${args.join(" ")} başarısız olmalıydı; stdout=${r.out}`).toBe(1);
  const e = JSON.parse(r.err);
  expect(typeof e.error).toBe("string");
  expect(Array.isArray(e.details)).toBe(true);
  return e;
}

/** CLI'ı eşzamanlı (asenkron alt süreç) koşar. */
export function runAsync(home: string, args: string[], env: Env = {}): Promise<Run> {
  const e: Env = { ...process.env, VLAD_HOME: home, ...NO_CLOUD_ENV, VLAD_MACHINE: MACHINE, ...env };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return new Promise((resolve) => {
    const c = spawn("node", [cli, ...args], { env: e as NodeJS.ProcessEnv });
    let out = "", err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("close", (code) => resolve({ code, out, err }));
  });
}

/** Geçici VLAD_HOME (kb/* alt klasörleri + schemas kopyası). */
export const newHome = (): string => makeHome();

export function writeConfig(home: string, cfg: object): void {
  writeFileSync(join(home, "vlad.config.json"), JSON.stringify(cfg));
}

export const CARD_REPO = "acme/alpha";

/** Proje kartı: `repo` ve isteğe bağlı `path`. */
export function writeProjectCard(home: string, slug = "alpha", o: { path?: string; repo?: string | null } = {}): void {
  const f = join(tmp("vlad-card-"), `${slug}.md`);
  writeFileSync(f, `---
slug: ${slug}
name: ${slug}
path: ${JSON.stringify(o.path ?? `/nonexistent/${slug}`)}
${o.repo === null ? "" : `repo: ${o.repo ?? CARD_REPO}\n`}stack: [ts]
status: active
autonomy: commit
last_activity: null
last_scanned: null
---

## Özet
x
`);
  ok(home, ["project", "write", slug, "--file", f]);
}

export function newTask(home: string, project = "alpha", extra: string[] = []): string {
  return ok<{ id: string }>(home, ["task", "new", "--project", project, "--title", "T", "--kind", "dev", "--body-file", "-", ...extra], {
    input: "## Tanım\nx\n",
  }).id;
}

export function listTasks(home: string): any[] {
  return ok<{ tasks: any[] }>(home, ["task", "list"]).tasks;
}
export const getTask = (home: string, id: string) => listTasks(home).find((t) => t.id === id);

/** Gerçek git deposu (main dalı, bir commit). */
export function gitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...a], { cwd: dir, stdio: "pipe" });
  g("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "1");
  g("add", ".");
  g("commit", "-q", "-m", "first");
  return dir;
}

export const sha40 = (c = "a") => c.repeat(40);

export const kbFiles = (home: string, dir: string): string[] => {
  const d = join(home, "kb", dir);
  return existsSync(d) ? readdirSync(d).sort() : [];
};
export const readKb = (home: string, ...p: string[]) => readFileSync(join(home, "kb", ...p), "utf8");
export const writeKb = (home: string, p: string, body: string) => {
  const f = join(home, "kb", p);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, body);
};
