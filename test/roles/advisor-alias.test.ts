import { cpSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { getRole } from "../../src/roles/store.js";
import { createTask, getTask } from "../../src/tasks/index.js";
import { kbPaths } from "../../src/kb/index.js";
import { makeHome } from "../helpers.js";

const repoRoles = resolve(import.meta.dirname, "..", "..", "roles");
const D = new Date(2026, 9, 15, 10, 0, 0);

beforeEach(() => {
  makeHome();
  mkdirSync(kbPaths().roles, { recursive: true });
  cpSync(join(repoRoles, "advisor.md"), join(kbPaths().roles, "advisor.md")); // only the merged role; old slugs have no file
});

describe("advisor rolü ve eski slug alias'ları", () => {
  it("advisor doğrudan çözülür (odaksız)", () => {
    const r = getRole("advisor");
    expect(r).toMatchObject({ slug: "advisor", kind: "advisory", model: "sonnet" });
    expect(r.title).not.toMatch(/odak/);
  });

  it.each(["finans", "pazarlama", "growth"])("eski slug %s advisor'a çözülür ve odağı başlığa yazar", (old) => {
    const r = getRole(old);
    expect(r.slug).toBe("advisor");
    expect(r.kind).toBe("advisory");
    expect(r.file).toMatch(/advisor\.md$/);
    expect(r.title).toContain(`odak: ${old}`);
  });

  it("görev eski slug'la oluşur, slug dosyada korunur (geçmiş görevler bozulmaz)", () => {
    const t = createTask({ project: "p", title: "t", kind: "research", body: "", role: "finans" }, D);
    expect(t.data.role).toBe("finans");
    expect(getTask(t.data.id).data.role).toBe("finans");
  });

  it("alias advisory kalır: dev görevinde reddedilir", () => {
    expect(() => createTask({ project: "p", title: "t", kind: "dev", body: "", role: "growth" }, D)).toThrow(/advisory\) dev görevinde/);
  });

  it("bilinmeyen slug hâlâ reddedilir; mevcut-rol listesi advisor'ı içerir", () => {
    expect(() => getRole("yok")).toThrow(/rol bulunamadı: yok; mevcut: .*advisor/);
  });
});
