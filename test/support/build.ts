import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function newest(dir: string): number {
  let m = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    m = Math.max(m, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return m;
}

export function tsc(root: string): void {
  const r = spawnSync("npx", ["tsc"], { cwd: root, shell: true, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tsc failed:\n${r.stdout}${r.stderr}`);
}

/**
 * Builds dist/ once, or with VLAD_SKIP_BUILD=1 trusts the existing build: it must not be older than src/** or package.json
 * (a stale dist would silently test old code).
 */
export function ensureBuild(root: string, env: Record<string, string | undefined> = process.env, build: (root: string) => void = tsc): void {
  if (env.VLAD_SKIP_BUILD !== "1") return build(root);
  const cli = join(root, "dist", "cli.js");
  const stale = !existsSync(cli) || statSync(cli).mtimeMs < Math.max(newest(join(root, "src")), statSync(join(root, "package.json")).mtimeMs);
  if (stale) throw new Error("dist bayat: önce npm run build (VLAD_SKIP_BUILD=1 iken dist, src/** ve package.json'dan eski olamaz)");
}
