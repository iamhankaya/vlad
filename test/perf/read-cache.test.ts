import { beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kbPaths } from "../../src/kb/index.js";
import { addFinding, getFinding, listFindingsWithWarnings, parsedFindingCacheSize, setFindingState } from "../../src/findings/store.js";
import { getRole, parsedRoleCacheSize } from "../../src/roles/store.js";
import { createTask, listTasks, listTasksWithWarnings } from "../../src/tasks/index.js";
import { makeHome } from "../helpers.js";

// T20261126-25: one CLI call lists findings several times (countOpenSevere + projectStatus per project); each pass re-parsed every file
const add = (project = "alpha", severity: "orta" | "yüksek" = "orta") => {
  writeFileSync(join(kbPaths().projects, `${project}.md`), "---\nslug: x\n---\n");
  return addFinding({ project, severity, source: "T20261022-01", title: "başlık" });
};

describe("bulgu ayrıştırma önbelleği", () => {
  let home: string;
  beforeEach(() => { home = makeHome(); });

  it("listeleme dosyaları önbelleğe alır; silinen dosyanın girdisi atılır", () => {
    const a = add();
    add();
    listFindingsWithWarnings();
    expect(parsedFindingCacheSize()).toBe(2);
    renameSync(a.file, join(home, "gone.md"));
    listFindingsWithWarnings();
    expect(parsedFindingCacheSize()).toBe(1);
  });

  it("yazılan bulgu sonraki listelemede yeni haliyle gelir", () => {
    const a = add();
    expect(listFindingsWithWarnings().findings[0].data.state).toBe("open");
    setFindingState(a.data.id, "deferred");
    expect(listFindingsWithWarnings().findings[0].data.state).toBe("deferred");
  });

  it("dışarıdan değişen dosya (aynı tik içinde bile) yeniden okunur", () => {
    const a = add();
    listFindingsWithWarnings();
    const text = readFileSync(a.file, "utf8").replace("state: open", "state: deferred");
    writeFileSync(join(home, "tmp.md"), text);
    renameSync(join(home, "tmp.md"), a.file); // atomic replace: new inode
    expect(listFindingsWithWarnings().findings[0].data.state).toBe("deferred");
  });

  it("döndürülen kayıt kopyadır: çağıranın değişikliği önbelleği bozmaz", () => {
    add();
    listFindingsWithWarnings().findings[0].data.title = "bozuldu";
    expect(listFindingsWithWarnings().findings[0].data.title).toBe("başlık");
  });

  it("önbellekteki dosya symlink ile değişirse önbellekten servis edilmez (F-vlad-036)", () => {
    const a = add();
    listFindingsWithWarnings();
    const target = join(home, "elsewhere.md");
    writeFileSync(target, readFileSync(a.file, "utf8"));
    renameSync(a.file, join(home, "old.md"));
    symlinkSync(target, a.file);
    expect(listFindingsWithWarnings().findings).toHaveLength(0); // listMdFiles skips links; the cache must not resurrect the old entry
    expect(parsedFindingCacheSize()).toBe(0);
  });

  it("şema hatası önbellekten de aynı uyarıyla döner", () => {
    const a = add();
    writeFileSync(a.file, readFileSync(a.file, "utf8").replace("severity: orta", "severity: dev"));
    const first = listFindingsWithWarnings().warnings;
    expect(first).toHaveLength(1);
    expect(listFindingsWithWarnings().warnings).toEqual(first);
  });

  it("getFinding önbellekten bağımsız güncel dosyayı okur", () => {
    const a = add();
    listFindingsWithWarnings();
    writeFileSync(a.file, readFileSync(a.file, "utf8").replace("title: başlık", "title: yeni"));
    expect(getFinding(a.data.id).data.title).toBe("yeni");
  });
});

describe("görev listesi: yalnız eşleşen kayıt klonlanır", () => {
  beforeEach(() => { makeHome(); });

  it("proje süzgeci sonucu değiştirmez ve kayıtlar bağımsız kopyadır", () => {
    createTask({ project: "alpha", title: "a", kind: "dev", body: "" });
    createTask({ project: "beta", title: "b", kind: "dev", body: "" });
    const alpha = listTasksWithWarnings({ project: "alpha" }).tasks;
    expect(alpha.map((t) => t.data.title)).toEqual(["a"]);
    alpha[0].data.title = "bozuldu";
    expect(listTasks().map((t) => t.data.title)).toEqual(["a", "b"]);
  });
});

describe("rol ayrıştırma önbelleği", () => {
  let home: string;
  beforeEach(() => { home = makeHome(); });
  const role = (slug: string, model: string) =>
    `---\nslug: ${slug}\ntitle: T\nkind: executor\nsummary: s\nmodel: ${model}\nskills:\n  - a\n---\n\nmetin\n`;

  it("aynı rol tek kez ayrıştırılır, değişince yeniden okunur", () => {
    mkdirSync(join(home, "roles"), { recursive: true });
    const file = join(home, "roles", "dev.md");
    writeFileSync(file, role("dev", "sonnet"));
    expect(getRole("dev").model).toBe("sonnet");
    getRole("dev");
    expect(parsedRoleCacheSize()).toBeGreaterThanOrEqual(1);
    writeFileSync(join(home, "tmp.md"), role("dev", "opus"));
    renameSync(join(home, "tmp.md"), file);
    expect(getRole("dev").model).toBe("opus");
  });

  it("döndürülen rol kopyadır", () => {
    mkdirSync(join(home, "roles"), { recursive: true });
    writeFileSync(join(home, "roles", "dev.md"), role("dev", "sonnet"));
    getRole("dev").skills.push("x");
    expect(getRole("dev").skills).toEqual(["a"]);
  });
});
