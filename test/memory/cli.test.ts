import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { makeHome } from "../helpers.js";

const cli = join(resolve(import.meta.dirname, "..", ".."), "dist", "cli.js");
let home: string;
beforeEach(() => { home = makeHome(); });

function vlad(args: string[], input?: string) {
  const r = spawnSync("node", [cli, ...args], { encoding: "utf8", input, env: { ...process.env, VLAD_HOME: home } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const json = (args: string[], input?: string) => {
  const r = vlad([...args, "--json"], input);
  expect(r.code, r.err).toBe(0);
  return JSON.parse(r.out);
};

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
