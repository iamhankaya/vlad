import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { makeHome } from "../helpers.js";
import { spawnVlad } from "../support/spawn-vlad.js";

let home: string;
beforeEach(() => { home = makeHome(); });

function vlad(args: string[], input?: string) {
  const r = spawnVlad({ args, input, env: { VLAD_HOME: home } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const json = (args: string[], input?: string) => {
  const r = vlad([...args, "--json"], input);
  expect(r.code, r.err).toBe(0);
  return JSON.parse(r.out);
};

describe("task list --fields/--limit (F-vlad-094)", { timeout: 30_000 }, () => {
  it("projects the json to the requested fields and keeps the newest N", () => {
    for (const t of ["bir", "iki", "üç"]) json(["task", "new", "--project", "alpha", "--title", t, "--kind", "dev", "--body-file", "-"], "## Tanım\nx\n");
    const all = json(["task", "list"]).tasks;
    expect(all).toHaveLength(3);
    const r = json(["task", "list", "--fields", "id,state,title", "--limit", "2"]).tasks;
    expect(r).toEqual(all.slice(-2).map((t: { id: string; state: string; title: string }) => ({ id: t.id, state: t.state, title: t.title })));
    expect(vlad(["task", "list", "--fields", "id,bozuk"]).code).toBe(1);
    expect(vlad(["task", "list", "--limit", "0"]).code).toBe(1);
  });
});

describe("task list --json varsayılan kısa çıktı / --full (T20261110-14)", { timeout: 30_000 }, () => {
  it("varsayılan: ağır/nadir alanlar yok (role_model, model_reason, integration_worktrees…); --full: eski tam çıktı; --fields: öncelikli", () => {
    json(["task", "new", "--project", "alpha", "--title", "çatı", "--kind", "pipeline", "--body-file", "-"], "## Tanım\nx\n");
    const short = json(["task", "list"]).tasks[0];
    const full = json(["task", "list", "--full"]).tasks[0];
    // desktop (src/models/task.ts) + skill'lerin okuduğu alanlar kısa çıktıda kalır
    for (const k of ["id", "project", "title", "kind", "state", "autonomy", "branch", "worktree", "session_id", "error", "role", "parent", "depends_on", "phase", "created", "updated", "effective_model"]) {
      if (k in full) expect(short, k).toHaveProperty(k);
    }
    for (const k of ["role_model", "integration_worktrees", "digested", "model", "model_reason", "report_file", "machine_reserved", "launch_op", "released_ops", "last_green_gate", "experiment"]) expect(short, k).not.toHaveProperty(k);
    expect(full).toHaveProperty("role_model");
    expect(full).toHaveProperty("integration_worktrees");
    expect(JSON.stringify(short).length).toBeLessThan(JSON.stringify(full).length);
    expect(json(["task", "list", "--fields", "id,role_model"]).tasks[0]).toEqual({ id: short.id, role_model: full.role_model });
    expect(vlad(["task", "list", "--full", "--fields", "id"]).code).toBe(1); // ikisi birlikte belirsiz
  });
});

describe("memory CLI", { timeout: 30_000 }, () => {
  it("decision add/list/set/migrate, kb search and project status/summary work end to end", () => {
    const card = join(home, "card.md");
    writeFileSync(card, "---\nslug: alpha\nname: Alpha\npath: C:\\dev\\alpha\nstack: [ts]\nstatus: active\nautonomy: commit\nlast_activity: null\nlast_scanned: null\n---\n\n## Özet\nx\n");
    json(["project", "write", "alpha", "--file", card]);

    const a = json(["decision", "add", "--project", "alpha", "--title", "Mimari bir", "--body-file", "-"], "- **Karar:** ilk mimari").id;
    const b = json(["decision", "add", "--project", "alpha", "--title", "Mimari iki", "--body-file", "-", "--supersedes", a], "- **Karar:** ikinci mimari").id;
    expect([a, b]).toEqual(["D-alpha-001", "D-alpha-002"]);
    expect(json(["decision", "list", "--project", "alpha"]).decisions.map((d: { id: string }) => d.id)).toEqual([b]);
    expect(json(["decision", "list", "--project", "alpha", "--all"]).decisions).toHaveLength(2);
    json(["decision", "set", b, "geçersiz"]);
    expect(json(["decision", "list", "--project", "alpha"]).decisions).toEqual([]);
    expect(vlad(["decision", "set", a, "yerine-geçti"]).code).toBe(1);
    expect(json(["decision", "migrate", "--dry-run"]).files).toEqual([]);

    const hits = json(["kb", "search", "ikinci mimari", "--project", "alpha", "--type", "decision"]).hits;
    expect(hits[0]).toMatchObject({ id: b, type: "decision", status: "geçersiz" });

    expect(json(["project", "status", "alpha"]).summary.state).toBe("yok");
    json(["project", "summary", "alpha", "--file", "-"], "Hedef: x");
    const s = json(["project", "status", "alpha"]);
    expect(s.summary).toMatchObject({ state: "güncel", text: "Hedef: x" });
    expect(vlad(["project", "status", "yok"]).code).toBe(1);
  });
});
