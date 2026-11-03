import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { makeHome } from "../helpers.js";

const cli = join(resolve(import.meta.dirname, "..", ".."), "dist", "cli.js");
let home: string;
const card = `---\nslug: alpha\nname: Alpha\npath: C:\dev\alpha\nstack: [ts]\nstatus: active\nautonomy: commit\nlast_activity: null\nlast_scanned: null\n---\n\n## Özet\nx\n\n## Açık konular\n- elle\n\n## Son aktivite\n- eski\n`;
function vlad(args: string[], input?: string) {
  const r = spawnSync("node", [cli, ...args], { encoding: "utf8", input, env: { ...process.env, VLAD_HOME: home } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const cardText = () => readFileSync(join(home, "kb", "projects", "alpha.md"), "utf8");
beforeEach(() => {
  home = makeHome();
  expect(vlad(["project", "write", "alpha", "--file", "-"], card).code).toBe(0);
});

describe("project refresh + automatic refresh", () => {
  it("project write adds the blocks; refresh <slug> and --all work; no argument fails", () => {
    expect(cardText()).toContain("vlad:derived open-findings");
    writeFileSync(join(home, "kb", "projects", "alpha.md"), cardText().replace(/<!-- vlad:derived open-findings -->[\s\S]*?<!-- \/vlad:derived -->/, "<!-- vlad:derived open-findings -->\nbozuk\n<!-- /vlad:derived -->"));
    expect(vlad(["project", "refresh", "alpha", "--json"]).code).toBe(0);
    expect(cardText()).not.toContain("bozuk");
    writeFileSync(join(home, "kb", "projects", "alpha.md"), cardText().replace("(açık bulgu yok)", "bozuk2"));
    const all = vlad(["project", "refresh", "--all", "--json"]);
    expect(JSON.parse(all.out).refreshed).toEqual(["alpha"]);
    expect(cardText()).not.toContain("bozuk2");
    expect(vlad(["project", "refresh"]).code).toBe(1);
  });
  it("finding add/set update the open-findings block; task set done updates Son aktivite; decisions only on explicit refresh", () => {
    const body = join(home, "b.md");
    writeFileSync(body, "## Tanım\nx\n");
    const tid = JSON.parse(vlad(["task", "new", "--project", "alpha", "--title", "Bitecek", "--kind", "dev", "--body-file", body, "--json"]).out).id as string;
    const fid = JSON.parse(vlad(["finding", "add", "--project", "alpha", "--severity", "yüksek", "--source", tid, "--title", "Açık bulgu başlığı", "--json"]).out).id as string;
    expect(cardText()).toContain("Açık bulgu başlığı");
    vlad(["finding", "set", fid, "fixed", "--by", tid]);
    expect(cardText()).not.toContain("Açık bulgu başlığı");
    for (const s of ["running", "awaiting_approval", "done"]) expect(vlad(["task", "set", tid, s]).code).toBe(0);
    expect(cardText()).toContain(`${tid} Bitecek`);
    vlad(["decision", "add", "--project", "alpha", "--title", "Yeni karar", "--body-file", "-"], "- **Karar:** k");
    expect(cardText()).not.toContain("D-alpha-001"); // not hooked (cost); an explicit refresh picks it up
    vlad(["project", "refresh", "alpha"]);
    expect(cardText()).toContain("D-alpha-001 Yeni karar");
    vlad(["decision", "set", "D-alpha-001", "geçersiz"]);
    vlad(["project", "refresh", "alpha"]);
    expect(cardText()).not.toContain("D-alpha-001 Yeni karar");
    expect(cardText()).toContain("- elle");
  });
});

