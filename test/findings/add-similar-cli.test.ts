import { beforeEach, describe, expect, it } from "vitest";
import { makeHome } from "../helpers.js";
import { spawnVlad } from "../support/spawn-vlad.js";

let home: string;
const card = "---\nslug: alpha\nname: Alpha\npath: C:\\dev\\alpha\nstack: [ts]\nstatus: active\nautonomy: commit\nlast_activity: null\nlast_scanned: null\n---\n\n## Özet\nx\n\n## Açık konular\n- elle\n";
const vlad = (args: string[], input?: string) => {
  const r = spawnVlad({ args, input, env: { VLAD_HOME: home } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const add = (title: string, extra: string[] = []) =>
  vlad(["finding", "add", "--project", "alpha", "--severity", "orta", "--source", "T20261109-01", "--title", title, ...extra]);

// real titles of F-vlad-desktop-166 / F-177 (same root cause; F-177 closed, its twin stayed open)
const T166 = "Ses: iptal edilen yakalama açılışı wake dinlemesini kapalı bırakabiliyor";
const T177 = "Ses: WakeSessionTests yük altında kararsız (gate kırmızısı)";

beforeEach(() => {
  home = makeHome();
  expect(vlad(["project", "write", "alpha", "--file", "-"], card).code).toBe(0);
});

describe("finding add: similar open finding warning", () => {
  it("--json: warnings [{similar}] when an open twin exists; the finding is still created", () => {
    const first = JSON.parse(add(T177, ["--json"]).out);
    expect(first.warnings).toBeUndefined();
    const r = add(T166, ["--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.id).toBe("F-alpha-002");
    expect(j.warnings).toEqual([{ similar: first.id }]);
  });
  it("text mode prints a warning line on stderr, exit 0", () => {
    add(T177);
    const r = add(T166);
    expect(r.code).toBe(0);
    expect(r.err).toContain("benzer açık bulgu: F-alpha-001");
  });
  it("no warning for an unrelated title or once the twin is closed", () => {
    add(T177);
    expect(JSON.parse(add("Gate: build.ps1 izin reddi", ["--json"]).out).warnings).toBeUndefined();
    expect(vlad(["finding", "set", "F-alpha-001", "fixed"]).code).toBe(0);
    expect(JSON.parse(add(T166, ["--json"]).out).warnings).toBeUndefined();
  });
});
