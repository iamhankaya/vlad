import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { kbPaths } from "../../src/kb/index.js";
import { getRole, listRolesWithWarnings } from "../../src/roles/store.js";
import { makeHome } from "../helpers.js";

const role = (slug: string, kind = "executor", title = `T ${slug}`) =>
  `---\nslug: ${slug}\ntitle: ${title}\nkind: ${kind}\nsummary: özet\n---\n\n## Sorumluluk\n- x\n`;

let dir: string;
beforeEach(() => {
  makeHome();
  dir = kbPaths().roles;
  mkdirSync(dir, { recursive: true });
});

describe("roles store", () => {
  it("lists valid roles sorted, with file path", () => {
    writeFileSync(join(dir, "tester.md"), role("tester"));
    writeFileSync(join(dir, "analyst.md"), role("analyst", "advisory"));
    const { roles, warnings } = listRolesWithWarnings();
    expect(warnings).toEqual([]);
    expect(roles.map((r) => r.slug)).toEqual(["analyst", "tester"]);
    expect(roles[0]).toMatchObject({ kind: "advisory", title: "T analyst", summary: "özet", file: join(dir, "analyst.md") });
  });

  it("invalid frontmatter, slug/file mismatch and broken yaml become warnings", () => {
    writeFileSync(join(dir, "a.md"), role("a", "boss"));
    writeFileSync(join(dir, "b.md"), role("other"));
    writeFileSync(join(dir, "c.md"), "---\nslug: [oops\n---\n");
    const { roles, warnings } = listRolesWithWarnings();
    expect(roles).toEqual([]);
    expect(warnings).toHaveLength(3);
    expect(warnings.join("\n")).toMatch(/b\.md: .*slug/);
  });

  it("a title with a double quote is rejected (it would split the launcher's claude argument)", () => {
    writeFileSync(join(dir, "qa.md"), `---\nslug: qa\ntitle: 'Senior "QA"'\nkind: executor\nsummary: s\n---\n`);
    const { roles, warnings } = listRolesWithWarnings();
    expect(roles).toEqual([]);
    expect(warnings[0]).toMatch(/qa\.md: .*title/);
  });

  it("reads CRLF files", () => {
    writeFileSync(join(dir, "tester.md"), role("tester").replace(/\n/g, "\r\n"));
    expect(listRolesWithWarnings().roles.map((r) => r.slug)).toEqual(["tester"]);
  });

  it("missing roles dir yields empty list", () => {
    rmSync(dir, { recursive: true, force: true });
    expect(listRolesWithWarnings()).toEqual({ roles: [], warnings: [] });
  });

  it("getRole returns a role and throws for an unknown slug listing available ones", () => {
    writeFileSync(join(dir, "tester.md"), role("tester"));
    expect(getRole("tester").kind).toBe("executor");
    expect(() => getRole("x")).toThrow(/rol bulunamadı: x; mevcut: tester/);
  });
});
