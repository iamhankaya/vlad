import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CACHE_MAX_ENTRIES, ReadCache } from "../../src/read/cache.ts";
import { cleanWarnings, vaultPathProblem } from "../../src/read/catalog.ts";
import { registerReadRoutes } from "../../src/read/routes.ts";
import { runVlad } from "../../src/vlad/cli.ts";
import { pairDevice, rig, signedCall } from "../helpers/client.ts";
import { readJson } from "../helpers/contract.ts";
import { doc, jsonSchema, validator } from "../helpers/openapi.ts";

const REPO = resolve(import.meta.dirname, "..", "..", "..");
const BUILD = join(REPO, `.cli-build-catalog-${process.pid}`); // fresh tsc output of src/: never a stale dist/
let tmp: string;
const saved = { ...process.env };

const schemaOf = (op: string, status: string) => {
  for (const item of Object.values<any>(doc.paths)) for (const m of Object.values<any>(item)) {
    if (m?.operationId === op) {
      const r = m.responses[status];
      return jsonSchema(r.$ref ? doc.components.responses[r.$ref.split("/").pop()!] : r);
    }
  }
  throw new Error(`no schema ${op} ${status}`);
};
const check = (op: string, status: number, body: unknown) => expect(validator(schemaOf(op, String(status)))(body)).toEqual([]);
const shape = (v: any): any =>
  Array.isArray(v) ? (v.length ? [shape(v[0])] : []) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : v === null ? null : typeof v;

const vlad = (args: string[]) => runVlad(args);
const write = (rel: string, text: string) => {
  const p = join(tmp, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
  return p;
};

const AUTH = { "x-test-auth": "ok" };
const auth: any = async (req: any, reply: any) => {
  if (req.headers["x-test-auth"] !== "ok") return reply.code(401).send({ error: { code: "unauthorized", message_tr: "Yetkisiz." } });
};

const SECRET = "GIZLI-KELIME-9731";
// values that live in front matter of kb files and must never reach a phone
const LEAKS = ["/srv/vlad-worktrees/T20261025-99", "vlad/T20261025-99", "sess-3f9a0c-gizli", "/home/vladapi/projeler/gizli-proje", "npm run gizli-gate"];
let app: FastifyInstance;
let nowMs = 1_000_000;

beforeAll(async () => {
  const r = spawnSync("npx", ["tsc", "-p", join(REPO, "tsconfig.json"), "--outDir", BUILD], { cwd: REPO, shell: true, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tsc failed:\n${r.stdout}${r.stderr}`);
  tmp = mkdtempSync(join(tmpdir(), "vlad-catalog-"));
  const home = join(tmp, "home");
  mkdirSync(home);
  cpSync(join(REPO, "schemas"), join(home, "schemas"), { recursive: true });
  cpSync(join(REPO, "roles"), join(home, "roles"), { recursive: true });
  for (const d of ["projects", "tasks", "cards", "journal", "findings"]) mkdirSync(join(tmp, "kb", d), { recursive: true });
  process.env.VLAD_HOME = home;
  process.env.VLAD_KB_DIR = join(tmp, "kb");
  process.env.VLAD_CLI = join(BUILD, "cli.js");
  process.env.CLAUDE_CODE_REMOTE = "";

  const card = [
    "---", "slug: vlad", "name: VLAD", `path: ${home}`, "stack: [ts]", "status: active", "autonomy: commit", "repo: iamhankaya/vlad",
    "exposure: internet", "last_activity: null", "last_scanned: null", "---", "", "## Özet", "Kalıcı hafıza ve iş dağıtıcısı.", "",
  ].join("\n");
  const bare = [
    "---", "slug: eski-proje", "name: Eski Proje", `path: ${home}`, "stack: [py]", "status: paused", "autonomy: plan",
    "last_activity: null", "last_scanned: null", "---", "", "## Özet", "x", "",
  ].join("\n");
  await vlad(["project", "write", "vlad", "--file", write("p1.md", card)]);
  await vlad(["project", "write", "eski-proje", "--file", write("p2.md", bare)]);

  // a task file and a card whose front matter carries server-side facts, plus a corrupt card
  write("kb/tasks/T20261025-99.md", ["---", "id: T20261025-99", `worktree: ${LEAKS[0]}`, `branch: ${LEAKS[1]}`, `session_id: ${LEAKS[2]}`, "---", "", "## Tanım", "izleme notu imza", ""].join("\n"));
  write("kb/projects/gizli-proje.md", ["---", "slug: gizli-proje", "name: Gizli", `path: ${LEAKS[3]}`, `gate: ${LEAKS[4]}`, "stack: [ts]", "status: active", "autonomy: plan", "last_activity: null", "last_scanned: null", "---", "", "## Özet", "yalnız bu görünür", ""].join("\n"));
  write("kb/projects/bozuk.md", `---\npath: ${tmp}/kb/projects\n: : :\n---\n`);
  // readable memory
  write("kb/decisions.md", "# Kararlar\n\n## 2026-10-24\nSıkı kapı: imza zarfı kararı.\n\n```\n# kod içi başlık değil\n```\n");
  write("home/vault/docs/rehber.md", "# Rehber\n\n## Kurulum\nimza adımları\n");
  // forbidden zones, each carrying a word a search could find
  write("kb/inbox/rapor.md", `# Gelen\n${SECRET} imza\n`);
  write("kb/logs/gunluk.md", `# Log\n${SECRET} imza\n`);
  write("kb/audit/2026-10.md", `# Denetim\n${SECRET} imza\n`);
  write("kb/grants/G-001.md", `# Devir\n${SECRET} imza\n`);
  // links that try to get in: into a forbidden folder, out of the tree, and through a harmless-looking name
  symlinkSync(join(tmp, "kb", "inbox"), join(tmp, "kb", "masum"));
  symlinkSync(join(tmp, "kb", "inbox", "rapor.md"), join(tmp, "kb", "kisayol.md"));
  write("disarida.md", "# Dışarıda\ndışarıda\n");
  symlinkSync(join(tmp, "disarida.md"), join(tmp, "kb", "cikis.md"));
  symlinkSync(join(tmp, "kb", "audit"), join(tmp, "home", "vault", "docs", "denetim"));

  // findings come from the CLI like everywhere else
  await vlad(["finding", "add", "--project", "vlad", "--severity", "yüksek", "--source", "T20261025-01", "--title", "Birinci bulgu", "--detail-file", write("d.md", "Ayrıntı metni")]);
  await vlad(["finding", "add", "--project", "vlad", "--severity", "düşük", "--source", "T20261025-01", "--title", "İkinci bulgu", "--state", "deferred"]);
  await vlad(["finding", "add", "--project", "eski-proje", "--severity", "orta", "--source", "T20261025-02", "--title", "Üçüncü bulgu"]);
  await vlad(["task", "new", "--project", "vlad", "--title", "Açık iş"]);
});
afterAll(() => {
  rmSync(BUILD, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

beforeEach(async () => {
  nowMs += 10_000;
  app = Fastify();
  registerReadRoutes(app, auth, { cache: new ReadCache(() => nowMs) });
  await app.ready();
});

const get = (url: string, headers: Record<string, string> = AUTH) => app.inject({ method: "GET", url, headers });
const file = (path: string) => get(`/v1/vault/file?path=${encodeURIComponent(path)}`);
const search = (q: string, zone?: string) => get(`/v1/vault/search?q=${encodeURIComponent(q)}${zone ? `&zone=${zone}` : ""}`);

describe("server: projects", () => {
  it("lists project cards with exposure mapped and open task counts", async () => {
    const res = await get("/v1/projects");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    check("listProjects", 200, body);
    expect(body.projects.map((p: any) => p.slug)).toEqual(["eski-proje", "gizli-proje", "vlad"]);
    expect(body.projects.find((p: any) => p.slug === "vlad")).toEqual({
      slug: "vlad", name: "VLAD", exposure: "internet", repo: "iamhankaya/vlad", open_tasks: 1, last_activity: null,
    });
    // a card without exposure/repo: "none" and null, never missing
    expect(body.projects.find((p: any) => p.slug === "eski-proje")).toMatchObject({ exposure: "none", repo: null, open_tasks: 0 });
    const fx = readJson("fixtures", "api", "list-projects.200.json").response.body;
    expect(Object.keys(body.projects[0]).sort()).toEqual(Object.keys(fx.projects[0]).sort());
    expect(JSON.stringify(body)).not.toContain(tmp); // the card's local path stays on the server
  });

  it("GET /projects/{slug}: card body without front matter; 404 and malformed slug", async () => {
    const res = await get("/v1/projects/vlad");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    check("getProject", 200, body);
    expect(body.card_md).toBe("## Özet\nKalıcı hafıza ve iş dağıtıcısı.");
    expect(body.card_md).not.toContain("path:");
    expect(Object.keys(body).sort()).toEqual(Object.keys(readJson("fixtures", "api", "get-project.200.json").response.body).sort());
    const miss = await get("/v1/projects/yok-boyle");
    expect(miss.statusCode).toBe(404);
    expect(miss.json()).toMatchObject({ error: { code: "bad_request", details: { reason: "not_found" } } });
    check("getProject", 404, miss.json());
    for (const bad of ["Vlad", "a%20b", "-x", "--help", "a%3Bls"]) expect((await get(`/v1/projects/${bad}`)).statusCode, bad).toBe(400);
  });
});

describe("server: findings", () => {
  it("lists findings and maps state to status; filters narrow", async () => {
    const all = (await get("/v1/findings")).json();
    check("listFindings", 200, all);
    expect(all.findings).toHaveLength(3);
    const first = all.findings.find((f: any) => f.title === "Birinci bulgu");
    expect(first).toMatchObject({ project: "vlad", severity: "yüksek", status: "open", detail: "Ayrıntı metni" });
    expect(first.id).toMatch(/^F-vlad-[0-9]{3}$/);
    expect(first).not.toHaveProperty("state");
    expect(Object.keys(first).sort()).toEqual(Object.keys(readJson("fixtures", "api", "list-findings.200.json").response.body.findings[0]).sort());

    const q = async (s: string) => (await get(`/v1/findings?${s}`)).json().findings.map((f: any) => f.title);
    expect(await q("project=vlad")).toHaveLength(2);
    expect(await q("status=deferred")).toEqual(["İkinci bulgu"]);
    expect(await q(`severity=${encodeURIComponent("orta")}`)).toEqual(["Üçüncü bulgu"]);
    expect(await q("project=vlad&status=open")).toEqual(["Birinci bulgu"]);
    expect(await q("status=fixed")).toEqual([]);
  });

  it("invalid filters are 400 with the field, never passed to the CLI", async () => {
    const res = await get("/v1/findings?severity=acil");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(readJson("fixtures", "api", "list-findings.400.json").response.body);
    check("listFindings", 400, res.json());
    for (const [qs, field] of [["status=open,fixed", "status"], ["project=A%20B", "project"], ["project=-x", "project"], ["project=--help", "project"], ["status=open&status=fixed", "status"]]) {
      const r = await get(`/v1/findings?${qs}`);
      expect(r.statusCode, qs).toBe(400);
      expect(r.json().error.details.field, qs).toBe(field);
    }
  });
});

describe("server: vault", () => {
  it("search is scored, returns schema-valid hits; reads match", async () => {
    const res = await search("imza", "kb");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    check("searchVault", 200, body);
    expect(body.hits.map((h: any) => h.path)).toContain("kb/decisions.md");
    expect(Object.keys(body.hits[0]).sort()).toEqual(["path", "score", "snippet"]);
    const scores = body.hits.map((h: any) => h.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    const docs = (await search("imza", "docs")).json();
    expect(docs.hits.map((h: any) => h.path)).toEqual(["vault/docs/rehber.md"]);
    const read = (await file("kb/decisions.md")).json();
    check("readVaultFile", 200, read);
    expect(read.headings).toEqual(["Kararlar", "2026-10-24"]); // fenced "#" line is not a heading
    expect(read.content).toContain("Sıkı kapı");
  });

  it("search: q is plain text, option-like and oversized values are refused or harmless", async () => {
    for (const bad of [{ url: "/v1/vault/search" }, { url: "/v1/vault/search?q=" }, { url: `/v1/vault/search?q=${"a".repeat(201)}` }, { url: "/v1/vault/search?q=x&zone=inbox" }, { url: "/v1/vault/search?q=x&zone=kb&zone=docs" }]) {
      const r = await get(bad.url);
      expect(r.statusCode, bad.url).toBe(400);
      check("searchVault", 400, r.json());
    }
    // a query that looks like a CLI option is searched for, not parsed
    const r = await search("--help");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ hits: [] });
    expect((await search(".*")).json()).toEqual({ hits: [] }); // no regex
  });

  it("server: vault path escape -> bad_request (encoded/double/backslash/null/symlink/case)", async () => {
    const attempts: Record<string, string> = {
      traversal: "kb/../../etc/passwd",
      traversal2: "kb/projects/../../../x.md",
      encoded: "%2e%2e/%2e%2e/etc/passwd",
      "encoded slash": "kb%2f..%2f..%2fetc",
      double: "%252e%252e/etc/passwd",
      triple: "%25252e%25252e/etc/passwd",
      backslash: "kb\\..\\..\\etc\\passwd",
      "backslash in name": "kb\\decisions.md",
      null: "kb/decisions.md\0.png",
      newline: "kb/decisions.md\n",
      absolute: "/etc/passwd",
      drive: "C:/Windows/win.ini",
      "outside zone": "src/cli.ts",
      "home root": "package.json",
      dotfile: "kb/.vlad.lock",
      dotdir: "kb/.git/config",
      "symlink to inbox dir": "kb/masum/rapor.md",
      "symlink to inbox file": "kb/kisayol.md",
      "symlink out of tree": "kb/cikis.md",
      "docs symlink to audit": "vault/docs/denetim/2026-10.md",
      "trailing dot": "kb/inbox./rapor.md",
      "trailing space": "kb/logs /gunluk.md",
      "ntfs stream": "kb/inbox::$DATA",
      "8.3 name": "kb/INBOX~1/rapor.md",
      "case KB/INBOX": "KB/INBOX/rapor.md",
      "case Kb/LoGs": "Kb/LoGs/gunluk.md",
      "case kb/Audit": "kb/Audit/2026-10.md",
      "case kb/GRANTS": "kb/GRANTS/G-001.md",
      "fullwidth": "kb/ｉｎｂｏｘ/rapor.md",
      "long s / kelvin": "kb/ınbox/rapor.md",
      "wrong extension": "kb/projects/vlad.md.bak",
      "not md": "package.json",
      "kb root dir": "kb",
    };
    for (const [name, path] of Object.entries(attempts)) {
      const r = await file(path);
      expect([400, 404], `${name}: ${path}`).toContain(r.statusCode);
      const text = r.body;
      expect(text, name).not.toContain(SECRET);
      expect(text, name).not.toContain("root:");
      expect(text, name).not.toContain("dışarıda");
      expect(text, name).not.toContain(tmp);
      if (r.statusCode === 400) check("readVaultFile", 400, r.json());
    }
    // the ones that must be refusals, not merely missing
    const refused = ["trailing dot", "trailing space", "ntfs stream", "8.3 name", "traversal", "encoded", "double", "backslash", "null", "absolute", "symlink to inbox dir", "symlink to inbox file", "symlink out of tree", "case KB/INBOX", "case Kb/LoGs", "docs symlink to audit"];
    for (const name of refused) {
      const r = await file(attempts[name]);
      expect(r.statusCode, name).toBe(400);
      expect(r.json().error.details).toEqual({ reason: "path_forbidden" });
    }
    // raw (not pre-encoded) query values reach the same refusal
    for (const raw of ["%2e%2e%2f%2e%2e%2fetc%2fpasswd", "%252e%252e%252fetc", "kb%5Cdecisions.md", "kb%2Fdecisions.md%00"]) {
      expect((await get(`/v1/vault/file?path=${raw}`)).statusCode, raw).toBe(400);
    }
    // missing / empty / repeated / oversized
    for (const url of ["/v1/vault/file", "/v1/vault/file?path=", `/v1/vault/file?path=${"a/".repeat(200)}`, "/v1/vault/file?path=kb/decisions.md&path=kb/decisions.md"]) {
      expect((await get(url)).statusCode, url).toBe(400);
    }
    // the allowed neighbours are fine, so the refusals above are not a broken route
    expect((await file("kb/decisions.md")).statusCode).toBe(200);
    expect((await file("./kb//decisions.md")).statusCode).toBe(200);
    // a missing file answers like a forbidden one: 400 either way, so the status says nothing about what exists behind a name
    const missing = await file("kb/yok.md");
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toEqual((await file("kb/inbox/yok.md")).json());
  });

  it("kb front matter never reaches the API (file body, headings and search snippets)", async () => {
    const task = (await file("kb/tasks/T20261025-99.md")).json();
    check("readVaultFile", 200, task);
    expect(task.content.trim()).toBe("## Tanım\nizleme notu imza");
    expect(task.headings).toEqual(["Tanım"]);
    const card = (await file("kb/projects/gizli-proje.md")).json();
    expect(card.content.trim()).toBe("## Özet\nyalnız bu görünür");
    expect((await get("/v1/projects/gizli-proje")).json().card_md).toBe("## Özet\nyalnız bu görünür");
    // snippets: words that occur only in front matter are not found; words in the body are, and the snippet is a body line
    for (const v of ["worktree", "session_id", "sess-3f9a0c", "vladapi", "gizli-gate", "slug:", "autonomy"]) {
      const res = await search(v);
      expect(res.statusCode, v).toBe(200);
      expect(res.body, v).not.toContain("T20261025-99.md");
      for (const l of LEAKS) expect(res.body, v).not.toContain(l);
    }
    const hit = (await search("izleme notu")).json().hits.find((h: any) => h.path === "kb/tasks/T20261025-99.md");
    expect(hit.snippet).toBe("izleme notu imza");
    // nothing from any response of the catalog carries a front matter value
    for (const url of ["/v1/projects", "/v1/projects/gizli-proje", "/v1/findings", "/v1/vault/search?q=gizli", "/v1/vault/search?q=imza"]) {
      const body = (await get(url)).body;
      for (const l of LEAKS) expect(body, `${url} ${l}`).not.toContain(l);
    }
  });

  it("warnings carry a file name and a fixed reason, never the CLI's text", async () => {
    const res = (await get("/v1/projects")).json();
    expect(res.warnings.some((w: string) => w.startsWith("bozuk.md:"))).toBe(true);
    expect(JSON.stringify(res.warnings)).not.toContain(tmp);
    expect(cleanWarnings(["x.md: ENOENT /srv/secret/x.md", "plain /etc/passwd"])).toEqual(["x.md: kayıt okunamadı", "kayıt okunamadı"]);
  });

  it("the read cache stays bounded for client-chosen keys", async () => {
    const cache = new ReadCache(() => nowMs);
    for (let i = 0; i < 10_000; i++) await cache.get(`vault read k${i}`, async () => i);
    expect(cache.size).toBeLessThanOrEqual(CACHE_MAX_ENTRIES);
    // recently used entries survive eviction; an expired entry is dropped when it is read again
    await cache.get("keep", async () => 1);
    for (let i = 0; i < 100; i++) { await cache.get("keep", async () => 2); await cache.get(`x${i}`, async () => i); }
    expect(await cache.get("keep", async () => 3)).toBe(1);
    nowMs += 5000;
    expect(await cache.get("keep", async () => 4)).toBe(4);
    expect(cache.size).toBeLessThanOrEqual(CACHE_MAX_ENTRIES);
  });

  it("vaultPathProblem agrees with the contract's examples", () => {
    expect(vaultPathProblem("kb/decisions.md")).toBeNull();
    expect(vaultPathProblem("vault/docs/rehber.md")).toBeNull();
    expect(vaultPathProblem("../../etc/passwd")).toBe("traversal");
    expect(vaultPathProblem("kb/INBOX/x.md")).toBe("sensitive");
    expect(vaultPathProblem("kb/%2e%2e/x.md")).toBe("encoded");
    for (const alias of ["kb/inbox./x.md", "kb/logs /x.md", "kb/inbox::$DATA", "kb/INBOX~1/x.md"]) expect(vaultPathProblem(alias), alias).toBe("alias");
  });

  it("server: kb/inbox and kb/logs forbidden at API", async () => {
    for (const p of ["kb/inbox/rapor.md", "kb/logs/gunluk.md", "kb/inbox", "kb/logs", "kb/inbox/processed/x.md", "kb/logs/../logs/gunluk.md"]) {
      const r = await file(p);
      expect(r.statusCode, p).toBe(400);
      expect(r.body).not.toContain(SECRET);
    }
    // forbidden-ness does not depend on the file existing: no oracle for what is in there
    expect((await file("kb/inbox/yok-boyle-bir-dosya.md")).statusCode).toBe(400);
    expect((await file("kb/logs/yok.md")).statusCode).toBe(400);
    // and the words inside them are not searchable
    for (const zone of [undefined, "kb"]) {
      const hits = (await search(SECRET, zone)).json().hits;
      expect(hits, String(zone)).toEqual([]);
    }
  });

  it("server: sensitive dirs (audit, grants) not listed", async () => {
    const all = (await search("imza")).json().hits.map((h: any) => h.path as string);
    expect(all.length).toBeGreaterThan(0);
    for (const p of all) {
      const low = p.toLowerCase();
      for (const bad of ["inbox", "logs", "audit", "grants", "masum", "kisayol", "cikis", "denetim", ".vlad"]) expect(low, p).not.toContain(bad);
    }
    for (const p of ["kb/audit/2026-10.md", "kb/grants/G-001.md", "kb/audit", "kb/grants"]) expect((await file(p)).statusCode, p).toBe(400);
    expect((await search(SECRET)).json().hits).toEqual([]);
  });

  // every call starts the real CLI (~0.2 s each), so this one is slow by construction, not by a timing assertion
  it("server: every vault search hit path returns 200 on /vault/file", { timeout: 90_000 }, async () => {
    let seen = 0;
    for (const q of ["imza", "özet", "rehber", "i"]) {
      for (const zone of [undefined, "kb", "docs"]) {
        const res = await search(q, zone);
        expect(res.statusCode, `${q} ${zone}`).toBe(200);
        for (const h of res.json().hits) {
          seen++;
          const r = await file(h.path);
          expect(r.statusCode, h.path).toBe(200);
          check("readVaultFile", 200, r.json());
        }
      }
    }
    expect(seen).toBeGreaterThan(5);
  });

  it("a vlad failure is a 503 without CLI text", async () => {
    const dead = Fastify();
    registerReadRoutes(dead, auth, { cache: new ReadCache(() => nowMs), timeoutMs: 1 });
    for (const url of ["/v1/projects", "/v1/findings", "/v1/vault/search?q=imza", "/v1/vault/file?path=kb/decisions.md"]) {
      const res = await dead.inject({ method: "GET", url, headers: AUTH });
      expect(res.statusCode, url).toBe(503);
      expect(res.json()).toMatchObject({ error: { code: "bad_request", details: { reason: "vlad_failed" } } });
      expect(JSON.stringify(res.json())).not.toContain(tmp);
    }
  });
});

describe("server: catalog routes on the real app", () => {
  it("signed reads are 200 and schema-valid; unsigned is 401; revoked device is refused", async () => {
    const r = rig({ read: { cache: new ReadCache(() => nowMs) } });
    const d = await pairDevice(r);
    const calls: [string, string][] = [
      ["listProjects", "/v1/projects"], ["getProject", "/v1/projects/vlad"], ["listFindings", "/v1/findings?project=vlad"],
      ["searchVault", "/v1/vault/search?q=imza"], ["readVaultFile", "/v1/vault/file?path=kb%2Fdecisions.md"],
    ];
    for (const [op, url] of calls) {
      const res = await signedCall(r, d, "GET", url);
      expect(res.statusCode, url).toBe(200);
      check(op, 200, res.json());
      const bare = await r.app.inject({ method: "GET", url });
      expect(bare.statusCode, url).toBe(401);
      expect(bare.json()).toEqual({ error: { code: "unauthorized", message_tr: "Yetkisiz." } });
    }
    const esc = await signedCall(r, d, "GET", "/v1/vault/file?path=kb%2Finbox%2Frapor.md");
    expect(esc.statusCode).toBe(400);
    expect(esc.body).not.toContain(SECRET);
    const miss = await signedCall(r, d, "GET", "/v1/projects/yok-boyle");
    expect(miss.statusCode).toBe(404);
    check("getProject", 404, miss.json());
  });
});
