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
  it("finding add/set update the open-findings block; task set done updates Son aktivite; decision add/set refresh only that project's Son aktivite", () => {
    const body = join(home, "b.md");
    writeFileSync(body, "## Tanım\nx\n");
    const tid = JSON.parse(vlad(["task", "new", "--project", "alpha", "--title", "Bitecek", "--kind", "dev", "--body-file", body, "--json"]).out).id as string;
    const fid = JSON.parse(vlad(["finding", "add", "--project", "alpha", "--severity", "yüksek", "--source", tid, "--title", "Açık bulgu başlığı", "--json"]).out).id as string;
    expect(cardText()).toContain("Açık bulgu başlığı");
    vlad(["finding", "set", fid, "fixed", "--by", tid]);
    expect(cardText()).not.toContain("Açık bulgu başlığı");
    expect(cardText()).not.toContain("recent-activity"); // hooks never add the Son aktivite block
    expect(vlad(["project", "refresh", "alpha"]).code).toBe(0); // only an explicit refresh does; "- eski" stays under the block
    expect(cardText()).toContain("<!-- /vlad:derived -->\n\n- eski\n");
    for (const s of ["running", "awaiting_approval", "done"]) expect(vlad(["task", "set", tid, s]).code).toBe(0);
    expect(cardText()).toContain(`${tid} Bitecek`);
    vlad(["decision", "add", "--project", "alpha", "--title", "Yeni karar", "--body-file", "-"], "- **Karar:** k");
    expect(cardText()).toContain("D-alpha-001 Yeni karar"); // hooked: only this project's activity block
    vlad(["decision", "set", "D-alpha-001", "geçersiz"]);
    expect(cardText()).not.toContain("D-alpha-001 Yeni karar");
    expect(cardText()).toContain("- elle");
  });
  it("a decision that supersedes another project's decision refreshes both cards (F-vlad-190)", () => {
    expect(vlad(["project", "write", "beta", "--file", "-"], card.replace(/alpha/g, "beta").replace("Alpha", "Beta")).code).toBe(0);
    vlad(["decision", "add", "--project", "alpha", "--title", "Eski karar", "--body-file", "-"], "- **Karar:** k");
    expect(vlad(["project", "refresh", "alpha"]).code).toBe(0); // adds the Son aktivite block
    expect(cardText()).toContain("D-alpha-001 Eski karar");
    expect(vlad(["decision", "add", "--project", "beta", "--title", "Yeni", "--supersedes", "D-alpha-001", "--body-file", "-"], "- **Karar:** k").code).toBe(0);
    expect(cardText()).not.toContain("D-alpha-001 Eski karar");
    // `decision set ... --superseded-by` is the same path
    vlad(["decision", "add", "--project", "alpha", "--title", "Ikinci", "--body-file", "-"], "- **Karar:** k");
    expect(cardText()).toContain("D-alpha-002 Ikinci");
    expect(vlad(["decision", "set", "D-alpha-002", "yerine-geçti", "--superseded-by", "D-beta-001"]).code).toBe(0);
    expect(cardText()).not.toContain("D-alpha-002 Ikinci");
  });
});

