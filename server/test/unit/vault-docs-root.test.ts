import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReadCache } from "../../src/read/cache.ts";
import { registerReadRoutes } from "../../src/read/routes.ts";

// S5x: the docs zone lives in the kb repo (`<kb>/docs`) and is served under the same virtual path vault/docs/…
const REPO = resolve(import.meta.dirname, "..", "..", "..");
const BUILD = join(REPO, `.cli-build-docsroot-${process.pid}`);
let tmp: string;
let app: FastifyInstance;
const saved = { ...process.env };
const SECRET = "GIZLI-DIS-KELIME-5521";
const write = (rel: string, text: string) => {
  const p = join(tmp, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
};
const auth: any = async () => {};
const get = (url: string) => app.inject({ method: "GET", url });
const file = (path: string) => get(`/v1/vault/file?path=${encodeURIComponent(path)}`);

beforeAll(async () => {
  const r = spawnSync("npx", ["tsc", "-p", join(REPO, "tsconfig.json"), "--outDir", BUILD], { cwd: REPO, shell: true, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tsc failed:\n${r.stdout}${r.stderr}`);
  tmp = mkdtempSync(join(tmpdir(), "vlad-docsroot-"));
  mkdirSync(join(tmp, "home"));
  cpSync(join(REPO, "schemas"), join(tmp, "home", "schemas"), { recursive: true });
  for (const d of ["projects", "tasks", "cards", "journal", "findings"]) mkdirSync(join(tmp, "kb", d), { recursive: true });
  process.env.VLAD_HOME = join(tmp, "home");
  process.env.VLAD_KB_DIR = join(tmp, "kb");
  process.env.VLAD_CLI = join(BUILD, "cli.js");
  process.env.CLAUDE_CODE_REMOTE = "";
  write("kb/decisions.md", "# Kararlar\nkb-kaydı\n");
  write("kb/docs/rehber.md", "# Rehber\n\n## Kurulum\nyeni-kok imza adımları\n");
  write("kb/inbox/rapor.md", `# Gelen\n${SECRET}\n`);
  write("home/vault/docs/eski.md", "# Eski\neski-kok\n");
  write("disarida.md", `# Dışarıda\n${SECRET}\n`);
  symlinkSync(join(tmp, "kb", "inbox"), join(tmp, "kb", "docs", "gelen"));
  symlinkSync(join(tmp, "disarida.md"), join(tmp, "kb", "docs", "cikis.md"));
  app = Fastify();
  registerReadRoutes(app, auth, { cache: new ReadCache() });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  rmSync(BUILD, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("server: vault docs root in the kb repo", () => {
  it("server: vault serves <kb>/docs as vault/docs, search finds it once, the leftover home copy is not served", async () => {
    const f = await file("vault/docs/rehber.md");
    expect(f.statusCode).toBe(200);
    expect(f.json()).toEqual({ path: "vault/docs/rehber.md", content: expect.stringContaining("yeni-kok"), headings: ["Rehber", "Kurulum"] });
    const s = await get("/v1/vault/search?q=yeni-kok");
    expect(s.json().hits.map((h: any) => h.path)).toEqual(["vault/docs/rehber.md"]);
    expect((await get("/v1/vault/search?q=eski-kok")).json()).toEqual({ hits: [] });
    expect((await file("vault/docs/eski.md")).statusCode).toBe(400);
  });

  it("server: vault kb/docs is refused (docs are not part of the kb zone)", async () => {
    for (const p of ["kb/docs/rehber.md", "KB/DOCS/rehber.md"]) expect((await file(p)).statusCode, p).toBe(400);
    expect((await file("kb/decisions.md")).statusCode).toBe(200);
  });

  it("server: vault path escape under the new docs root -> bad_request", async () => {
    const attempts = [
      "vault/docs/../../etc/passwd", "vault/docs/../inbox/rapor.md", "vault/docs/%2e%2e/inbox/rapor.md", "vault/docs/%252e%252e/inbox/rapor.md",
      "vault\\docs\\rehber.md", "vault/docs/rehber.md\0.png", "vault/docs/gelen/rapor.md", "vault/docs/cikis.md", "VAULT/DOCS/gelen/rapor.md", "vault/docs/.git/config",
    ];
    for (const p of attempts) {
      const r = await file(p);
      expect(r.statusCode, p).toBe(400);
      expect(r.json().error.details).toEqual({ reason: "path_forbidden" });
      expect(r.body, p).not.toContain(SECRET);
      expect(r.body, p).not.toContain(tmp);
    }
    for (const raw of ["vault%2Fdocs%2F..%2F..%2Fetc%2Fpasswd", "vault/docs/%252e%252e/x", "vault/docs/rehber.md%00"]) expect((await get(`/v1/vault/file?path=${raw}`)).statusCode, raw).toBe(400);
    expect((await get(`/v1/vault/search?q=${SECRET}`)).json()).toEqual({ hits: [] });
  });
});
