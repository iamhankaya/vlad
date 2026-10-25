// T1 kabul: S5 (vault search|read|ls) — plan §Arayüzler `vlad vault …`, §S5.
// İzin listesi: `kb/` (hariç kb/inbox, kb/logs) ve `vault/docs/`; realpath kökte kalmalı; büyük/küçük harf farkıyla yasak aşılamaz.
// Not: null bayt argv ile iletilemez (işletim sistemi sınırı); onun yerine `%00` biçimi sınanır.
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { fail, newHome, ok, run, tmp, writeKb, writeProjectCard } from "./helpers.js";

let home: string;
let outside: string; // kökün dışındaki gizli dosya
const SECRET = "DISARIDAKI-GIZLI-ICERIK-7f3a";
const write = (rel: string, body: string) => { const f = join(home, rel); mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, body); };

beforeEach(() => {
  home = newHome();
  outside = tmp("vlad-out-");
  writeFileSync(join(outside, "secret.md"), `# s\n${SECRET}\n`);
  writeProjectCard(home);
  write("vault/docs/notlar.md", "# Başlık\nmerhaba dünya\n## Alt Bölüm\nIstanbul İŞLEM ışık\n## Son\nbitiş metni\n");
});

const leaks = (r: { out: string; err: string }) => r.out.includes(SECRET) || r.err.includes(SECRET);

describe("records: vault read — path validation (S5)", () => {
  it.each([
    ["../../etc/passwd"], ["../outside.md"], ["kb/../../etc/passwd"], ["vault/docs/../../../etc/passwd"],
    ["/etc/passwd"], ["C:\\Windows\\win.ini"], ["..\\..\\etc\\passwd"], ["kb\\..\\..\\x"],
    ["%2e%2e/%2e%2e/etc/passwd"], ["%252e%252e/%252e%252e/etc/passwd"], ["kb/projects/alpha.md%00.png"], ["vault/docs/notlar.md%00"],
  ])("records: vault read %s rejected (error key, exit 1, no content)", (p) => {
    const r = run(home, ["vault", "read", p, "--json"]);
    expect(r.code, r.out).toBe(1);
    expect(JSON.parse(r.err).error).toBeTruthy();
    expect(r.out).toBe("");
  });
  it("records: vault absolute path inside the home is still rejected (paths are relative to the allowlist roots)", () => {
    fail(home, ["vault", "read", join(home, "vault", "docs", "notlar.md")]);
  });
  it("records: vault symlink escape rejected (file link and directory link)", () => {
    symlinkSync(join(outside, "secret.md"), join(home, "vault", "docs", "link.md"));
    symlinkSync(outside, join(home, "vault", "docs", "linkdir"));
    for (const p of ["vault/docs/link.md", "vault/docs/linkdir/secret.md"]) {
      const r = run(home, ["vault", "read", p, "--json"]);
      expect(r.code, p).toBe(1);
      expect(leaks(r)).toBe(false);
    }
    expect(leaks(run(home, ["vault", "search", SECRET, "--json"]))).toBe(false);
    expect(leaks(run(home, ["vault", "ls", "vault/docs/linkdir", "--json"]))).toBe(false);
  });
  it("records: vault kb/inbox and KB/LOGS case variants forbidden", () => {
    write("kb/inbox/rapor.md", "# gelen\ninbox-gizli\n");
    write("kb/logs/log.md", "# log\nlog-gizli\n");
    for (const p of [
      "kb/inbox/rapor.md", "KB/INBOX/rapor.md", "kb/Inbox/rapor.md", "Kb/iNbOx/rapor.md", "kb/inbox/../inbox/rapor.md", "kb/./inbox/rapor.md",
      "kb/logs/log.md", "KB/LOGS/log.md", "kb/Logs/log.md", "kb//logs//log.md",
    ]) {
      const r = run(home, ["vault", "read", p, "--json"]);
      expect(r.code, p).toBe(1);
      expect(r.out + r.err).not.toContain("gizli\n");
      expect(r.out).not.toContain("-gizli");
    }
    fail(home, ["vault", "ls", "kb/inbox"]);
    fail(home, ["vault", "ls", "KB/LOGS"]);
  });
  it("read of a missing file, a directory and a non-markdown file errors", () => {
    write("kb/x.json", "{}");
    fail(home, ["vault", "read", "vault/docs/yok.md"]);
    fail(home, ["vault", "read", "vault/docs"]);
    fail(home, ["vault", "read", "kb/x.json"]);
  });
});

describe("records: vault read — content (S5)", () => {
  it("returns {path, content, headings[]} for an allowlisted file", () => {
    const r = ok<any>(home, ["vault", "read", "vault/docs/notlar.md"]);
    expect(r.path).toBe("vault/docs/notlar.md");
    expect(r.content).toContain("merhaba dünya");
    expect(r.headings.map((h: any) => h.text)).toEqual(["Başlık", "Alt Bölüm", "Son"]);
    expect(r.headings.map((h: any) => h.level)).toEqual([1, 2, 2]);
  });
  it("reads kb cards too", () => {
    expect(ok<any>(home, ["vault", "read", "kb/projects/alpha.md"]).content).toContain("slug: alpha");
  });
  it("records: vault heading read returns section", () => {
    const r = ok<any>(home, ["vault", "read", "vault/docs/notlar.md", "--heading", "Alt Bölüm"]);
    expect(r.content).toContain("Istanbul");
    expect(r.content).not.toContain("merhaba dünya");
    expect(r.content).not.toContain("bitiş metni");
  });
  it("heading read of a missing heading errors", () => {
    fail(home, ["vault", "read", "vault/docs/notlar.md", "--heading", "Yok Böyle"]);
  });
  it("records: vault binary and invalid utf8 and size cap", () => {
    writeFileSync(join(home, "vault", "docs", "bin.md"), Buffer.from([0x23, 0x20, 0x61, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0x00, 0x01]));
    writeFileSync(join(home, "vault", "docs", "bad.md"), Buffer.from("# ok\nmerhaba \xff\xfe bozuk\n", "latin1"));
    writeFileSync(join(home, "vault", "docs", "big.md"), "# büyük\n" + "x".repeat(20 * 1024 * 1024));
    for (const f of ["bin.md", "bad.md", "big.md"]) {
      const r = run(home, ["vault", "read", `vault/docs/${f}`, "--json"]);
      expect([0, 1], f).toContain(r.code);
      if (r.code === 0) {
        const j = JSON.parse(r.out);
        expect(typeof j.content).toBe("string");
        if (f === "big.md") expect(j.content.length).toBeLessThan(20 * 1024 * 1024); // sınırsız dönmemeli
      } else {
        expect(JSON.parse(r.err).error).toBeTruthy(); // çökme/yığın izi değil, yapılandırılmış hata
      }
      expect(r.err).not.toMatch(/\n\s+at /); // yığın izi yok
    }
    // diğer dosyalar bu yüzden bozulmaz
    ok(home, ["vault", "read", "vault/docs/notlar.md"]);
  });
});

describe("records: vault search (S5)", () => {
  it("records: vault turkish İ/ı search", () => {
    write("vault/docs/tr.md", "# TR\nİSTANBUL boğazı\nışık ve IŞIK\n");
    const hit = (q: string) => ok<any>(home, ["vault", "search", q]).hits.map((h: any) => h.path);
    expect(hit("istanbul")).toContain("vault/docs/tr.md");
    expect(hit("İstanbul")).toContain("vault/docs/tr.md");
    expect(hit("ışık")).toContain("vault/docs/tr.md");
    expect(hit("IŞIK")).toContain("vault/docs/tr.md");
    expect(hit("ISTANBUL")).toContain("vault/docs/tr.md");
  });
  it("search is case-insensitive in plain ASCII", () => {
    expect(ok<any>(home, ["vault", "search", "MERHABA"]).hits.map((h: any) => h.path)).toContain("vault/docs/notlar.md");
  });
  it("search ranks by score (more matches first) and scores are non-increasing", () => {
    write("vault/docs/az.md", "# az\nkelimex bir kez\n");
    write("vault/docs/cok.md", "# çok\nkelimex kelimex kelimex kelimex\nkelimex\n");
    const hits = ok<any>(home, ["vault", "search", "kelimex"]).hits;
    expect(hits.map((h: any) => h.path)).toEqual(["vault/docs/cok.md", "vault/docs/az.md"]);
    const scores = hits.map((h: any) => h.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(scores[0]).toBeGreaterThan(scores[1]);
  });
  it("--zone docs / --zone kb restrict results; invalid zone errors", () => {
    write("vault/docs/z.md", "# z\nzonetoken\n");
    write("kb/journal/2026-01.md", "# j\nzonetoken\n");
    const paths = (z?: string) => ok<any>(home, ["vault", "search", "zonetoken", ...(z ? ["--zone", z] : [])]).hits.map((h: any) => h.path).sort();
    expect(paths()).toEqual(["kb/journal/2026-01.md", "vault/docs/z.md"]);
    expect(paths("docs")).toEqual(["vault/docs/z.md"]);
    expect(paths("kb")).toEqual(["kb/journal/2026-01.md"]);
    fail(home, ["vault", "search", "zonetoken", "--zone", "inbox"]);
  });
  it("--limit bounds the result count", () => {
    for (let i = 0; i < 5; i++) write(`vault/docs/l${i}.md`, "# l\nlimittoken\n");
    expect(ok<any>(home, ["vault", "search", "limittoken", "--limit", "2"]).hits).toHaveLength(2);
    expect(ok<any>(home, ["vault", "search", "limittoken"]).hits).toHaveLength(5);
  });
  it("records: vault search lists only allowlisted paths (no inbox, logs, grants, audit)", () => {
    const T = "yasakli-belirteci-9c1";
    for (const p of ["kb/inbox/a.md", "kb/logs/b.md", "kb/grants/G-001.md", "kb/audit/2026-10.md"]) write(p, `# x\n${T}\n`);
    write("kb/audit/2026-10.jsonl", `{"detail":"${T}"}\n`);
    write("vault/docs/ok.md", `# ok\n${T}\n`);
    const paths = ok<any>(home, ["vault", "search", T]).hits.map((h: any) => h.path);
    expect(paths).toEqual(["vault/docs/ok.md"]);
  });
  it("every search hit path is readable with `vault read` (search/read allowlists agree)", () => {
    write("kb/journal/j.md", "# j\ntutarlilik\n");
    for (const h of ok<any>(home, ["vault", "search", "tutarlilik"]).hits) ok(home, ["vault", "read", h.path]);
    for (const h of ok<any>(home, ["vault", "search", "merhaba"]).hits) ok(home, ["vault", "read", h.path]);
  });
  it("records: vault empty and 10k-char query bounded", () => {
    for (const q of ["", " ", "x".repeat(10_000), "İ".repeat(10_000)]) {
      const r = run(home, ["vault", "search", q, "--json"]);
      expect([0, 1], `len=${q.length}`).toContain(r.code);
      if (r.code === 0) expect(JSON.parse(r.out).hits.length).toBeLessThanOrEqual(20);
      else expect(JSON.parse(r.err).error).toBeTruthy();
    }
  }, 60_000);
  it("search never leaks content from outside the roots via symlinks", () => {
    symlinkSync(outside, join(home, "vault", "docs", "linkdir"));
    expect(leaks(run(home, ["vault", "search", SECRET, "--json"]))).toBe(false);
    expect(ok<any>(home, ["vault", "search", SECRET]).hits).toEqual([]);
  });
});

describe("records: vault ls (S5)", () => {
  it("without argument lists the roots kb and vault/docs", () => {
    const paths = ok<any>(home, ["vault", "ls"]).entries.map((e: any) => e.path).sort();
    expect(paths).toEqual(["kb", "vault/docs"]);
  });
  it("lists a directory; hides inbox/logs from the kb listing", () => {
    write("kb/inbox/a.md", "x");
    write("kb/logs/a.md", "x");
    const names = ok<any>(home, ["vault", "ls", "kb"]).entries.map((e: any) => e.path);
    expect(names).toContain("kb/projects");
    expect(names).not.toContain("kb/inbox");
    expect(names).not.toContain("kb/logs");
    const docs = ok<any>(home, ["vault", "ls", "vault/docs"]).entries.map((e: any) => e.path);
    expect(docs).toContain("vault/docs/notlar.md");
  });
  it("rejects escapes", () => {
    for (const p of ["..", "../..", "/", "/etc", "kb/../..", "..\\.."]) {
      const r = run(home, ["vault", "ls", p, "--json"]);
      expect(r.code, p).toBe(1);
    }
  });
});
void writeKb;
