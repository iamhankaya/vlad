// F-247 kabulü (T20261105-62; plan "F-247 arayüzü"): resume `--continue` kullanmaz. `src/launcher/resume.ts` `resumeFlags(sessionId: string | null): string[]`
// = ["--resume", id]; id yoksa hata (sessizce --continue yok). Betikler (posix) `--continue` üretmez.
// Çözümleme sırası: açık session_id → soleTranscriptSession(worktree) → hata (çağıran tarafta); 0/1/çok transkript `soleTranscriptSession` ile test edilir.
// U4a'ya kadar KIRMIZI.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPosixScript } from "../../src/launcher/posix.js";
import { claudeProjectDir, soleTranscriptSession } from "../../src/tasks/liveness.js";
import { rmTemp } from "../helpers.js";

let base: string;
beforeEach(() => { base = realpathSync.native(mkdtempSync(join(tmpdir(), "vlad-u4f247-"))); });
afterEach(() => rmTemp(base));

describe("F-247 resumeFlags", () => {
  it("src/launcher/resume.ts resumeFlags(id) ⇒ ['--resume', id]; --continue asla", async () => {
    const mod = (await import("../../src/launcher/resume.js").catch(() => null)) as { resumeFlags?: (s: string | null) => string[] } | null;
    expect(mod?.resumeFlags, "src/launcher/resume.ts resumeFlags export etmeli").toBeTypeOf("function");
    expect(mod!.resumeFlags!("abc-123")).toEqual(["--resume", "abc-123"]);
  });
  it("oturum kimliği yoksa (null) sessizce devam etmez: hata fırlatır, '--continue' döndürmez", async () => {
    const mod = (await import("../../src/launcher/resume.js").catch(() => null)) as { resumeFlags?: (s: string | null) => string[] } | null;
    expect(mod?.resumeFlags).toBeTypeOf("function");
    let out: string[] | undefined;
    let threw = false;
    try { out = mod!.resumeFlags!(null); } catch { threw = true; }
    expect(threw || !(out ?? []).includes("--continue")).toBe(true);
    expect(threw).toBe(true);
  });
});

describe("F-247 betik: --continue üretilmez", () => {
  const req = (resume?: { sessionId?: string }) => ({ taskId: "T20261101-01", cwd: join(base, "wt"), prompt: "p", env: {}, title: "t", ...(resume ? { resume } : {}) });
  it("açık oturum kimliği ⇒ --resume 'id'", () => {
    const s = buildPosixScript(req({ sessionId: "sess-1" }));
    expect(s).toContain("--resume 'sess-1'");
    expect(s).not.toContain("--continue");
  });
  it("oturum kimliği olmayan resume ⇒ betik '--continue' içermez (ya hata ya --resume'suz taze oturum değil, açık hata)", () => {
    let s: string | null = null;
    try { s = buildPosixScript(req({})); } catch { /* hata kabul: sessiz --continue yok */ }
    if (s !== null) expect(s).not.toContain("--continue");
  });
});

describe("F-247 soleTranscriptSession: 0 / 1 / çok transkript", () => {
  const worktree = () => join(base, "wt");
  const put = (cfg: string, ids: string[]) => {
    const d = join(cfg, "projects", claudeProjectDir(worktree()));
    mkdirSync(d, { recursive: true });
    for (const id of ids) writeFileSync(join(d, `${id}.jsonl`), "{}\n");
  };
  it("transkript yok ⇒ null; tek ⇒ onun kimliği; birden çok ⇒ null (belirsiz, hata yolu)", () => {
    const cfg = join(base, "claude"); mkdirSync(cfg);
    expect(soleTranscriptSession(worktree(), cfg)).toBeNull();
    put(cfg, ["s1"]);
    expect(soleTranscriptSession(worktree(), cfg)).toBe("s1");
    put(cfg, ["s2"]);
    expect(soleTranscriptSession(worktree(), cfg)).toBeNull();
  });
});
