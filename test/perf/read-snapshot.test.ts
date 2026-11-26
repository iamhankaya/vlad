import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kbPaths, listMdFiles, writeFileAtomic } from "../../src/kb/index.js";
import { withReadSnapshot } from "../../src/kb/snapshot.js";
import { createTask, listTasks, setState } from "../../src/tasks/index.js";
import { makeHome } from "../helpers.js";

// T20261126-25: inside a read snapshot a directory is listed and each file stat'ed once; every kb write ends it
describe("okuma anlık görüntüsü", () => {
  beforeEach(() => { makeHome(); });

  const sneak = (file: string, from: string, to: string) => writeFileSync(file, readFileSync(file, "utf8").replace(from, to)); // not a kb write path: no invalidation

  it("kapsam içinde aynı liste ve kayıt tekrar kullanılır", () => {
    const t = createTask({ project: "alpha", title: "a", kind: "dev", body: "" });
    withReadSnapshot(() => {
      expect(listTasks().map((x) => x.data.title)).toEqual(["a"]);
      sneak(t.file, "title: a", "title: b");
      writeFileSync(join(kbPaths().tasks, "T20990101-01.md"), "---\nid: x\n---\n");
      expect(listTasks().map((x) => x.data.title)).toEqual(["a"]);
      expect(listMdFiles(kbPaths().tasks)).toHaveLength(1);
    });
  });

  it("kapsam dışında her listeleme diski yeniden okur", () => {
    const t = createTask({ project: "alpha", title: "a", kind: "dev", body: "" });
    withReadSnapshot(() => listTasks());
    sneak(t.file, "title: a", "title: b");
    expect(listTasks().map((x) => x.data.title)).toEqual(["b"]);
  });

  it("kapsam içindeki kb yazımı görüntüyü geçersiz kılar", () => {
    const t = createTask({ project: "alpha", title: "a", kind: "dev", body: "" });
    withReadSnapshot(() => {
      listTasks();
      setState(t.data.id, "running");
      expect(listTasks()[0].data.state).toBe("running");
      writeFileAtomic(join(kbPaths().tasks, "notes.md"), "x");
      expect(listMdFiles(kbPaths().tasks)).toHaveLength(2);
    });
  });

  it("hata fırlatan kapsam görüntüyü kapatır", () => {
    const t = createTask({ project: "alpha", title: "a", kind: "dev", body: "" });
    expect(() => withReadSnapshot(() => { listTasks(); throw new Error("x"); })).toThrow("x");
    sneak(t.file, "title: a", "title: b");
    expect(listTasks()[0].data.title).toBe("b");
  });

  it("iç içe kapsam dıştakini erken kapatmaz", () => {
    const t = createTask({ project: "alpha", title: "a", kind: "dev", body: "" });
    withReadSnapshot(() => {
      withReadSnapshot(() => listTasks());
      sneak(t.file, "title: a", "title: b");
      expect(listTasks()[0].data.title).toBe("a");
    });
  });
});
