import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reconcileApplyWrite } from "../../src/agent/ops/apply-write.js";
import { installPlan } from "../../src/agent/install.js";
import { rmTemp } from "../helpers.js";
import { makeHomePair, spawnVlad, type HomePair } from "./harness.js";

// Son kapı Codex 3. tur: P1 işçide yazma koruması fail-closed, P2 çok satırlı log uzlaştırması, P2 Windows VLAD_HOME.
const config = { machines: [{ name: "mac", os: "darwin", agent: { host: "127.0.0.1", port: 41001 } }, { name: "windows", os: "win32", agent: { host: "127.0.0.1", port: 41002 } }], brain: "mac" };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

function snapshot(dir: string, out: Record<string, string> = {}, base = dir): Record<string, string> {
  for (const e of readdirSync(dir)) {
    if (e === ".git") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) snapshot(p, out, base);
    else out[p.slice(base.length)] = readFileSync(p, "utf8");
  }
  return out;
}
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...a], { cwd, stdio: "pipe", encoding: "utf8" }).trim();

function pair(): HomePair {
  const p = makeHomePair({ config });
  cleanups.push(() => rmTemp(dirname(p.brain.home)), () => p.cleanup());
  return p;
}

describe("P1: işçide açık izinli salt okuma listesi dışı komut reddedilir (fail-closed)", () => {
  it("`kb commit` işçide kb klonunu commit'lemez", () => {
    const p = pair();
    git(p.worker.kb, "init", "-q", "-b", "main");
    writeFileSync(join(p.worker.kb, "a.md"), "1");
    git(p.worker.kb, "add", "-A"); git(p.worker.kb, "commit", "-q", "-m", "i");
    writeFileSync(join(p.worker.kb, "b.md"), "kirli");
    const head = git(p.worker.kb, "rev-parse", "HEAD");
    const r = spawnVlad(p.worker, ["kb", "commit", "x"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/beyin değil/);
    expect(git(p.worker.kb, "rev-parse", "HEAD")).toBe(head);
  });

  it("`task launch` işçide reddedilir ve kb'yi değiştirmez", () => {
    const p = pair();
    mkdirSync(join(p.worker.kb, "tasks"), { recursive: true });
    const before = snapshot(p.worker.kb);
    const r = spawnVlad(p.worker, ["task", "launch", "T20261102-01", "--external"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/beyin değil/);
    expect(snapshot(p.worker.kb)).toEqual(before);
  });

  it("salt okuma / yerel komutlar işçide çalışmaya devam eder", () => {
    const p = pair();
    for (const argv of [["task", "list", "--json"], ["project", "list", "--json"], ["inbox", "count"], ["queue", "list"]]) {
      const r = spawnVlad(p.worker, argv);
      expect(r.err, argv.join(" ")).not.toMatch(/beyin değil/);
    }
  });
});

describe("P2: çok satırlı task.log uzlaştırması", () => {
  it("yazılmış çok satırlı log 'applied'; yarım/farklı devam satırı 'not-applied'", () => {
    const p = pair();
    const saved = process.env.VLAD_HOME;
    cleanups.push(() => { if (saved === undefined) delete process.env.VLAD_HOME; else process.env.VLAD_HOME = saved; });
    writeFileSync(join(p.brain.home, "card.md"), `---\nslug: alpha\nname: Alpha\npath: ${JSON.stringify(p.brain.home)}\nstack: [ts]\nstatus: active\nautonomy: commit\nlast_activity: null\nlast_scanned: null\n---\n\n## Özet\nx\n`);
    expect(spawnVlad(p.brain, ["project", "write", "alpha", "--file", join(p.brain.home, "card.md")]).code).toBe(0);
    const made = spawnVlad(p.brain, ["task", "new", "--project", "alpha", "--title", "T", "--kind", "dev", "--body-file", "-", "--json"], { stdin: "## Tanım\nx\n" });
    const id = JSON.parse(made.out).id as string;
    process.env.VLAD_HOME = p.brain.home;
    const ts = Date.now() - 1000;
    const rec = (text: string) => ({ ts, args: { cmd: "task.log", id, text } }) as any;
    expect(spawnVlad(p.brain, ["task", "log", id, "birinci\nikinci"]).code).toBe(0);
    expect(reconcileApplyWrite(rec("birinci\nikinci"))).toBe("applied");
    // ilk satır aynı ama devam satırı farklı → bu istek yazılmamış
    expect(reconcileApplyWrite(rec("birinci\nüçüncü"))).toBe("not-applied");
    // yalnız ilk satır eşleşmesi yetmez
    expect(reconcileApplyWrite(rec("birinci\nikinci\nüçüncü"))).toBe("not-applied");
    // CRLF'li istek ve sondaki boşluk/satır sonu: kayıtlı gövde normalize/kırpılmıştır
    expect(reconcileApplyWrite(rec("birinci\r\nikinci"))).toBe("applied");
    expect(reconcileApplyWrite(rec("birinci\nikinci  \n"))).toBe("applied");
  });
});

describe("P2: Windows zamanlanmış görevi VLAD_HOME'u korur", () => {
  it("başlatma betiği VLAD_HOME'u ayarlar ve görev o betiği çalıştırır", () => {
    const w = installPlan("win32", { node: "C:\\n\\node.exe", cli: "C:\\v\\dist\\cli.js", home: "D:\\my vlad", path: "p" });
    expect(w.content).toContain("chcp 65001 >nul"); // cmd OEM kod sayfasıyla okur; UTF-8 yazılan ASCII dışı yollar bozulmasın
    expect(w.content).toContain('set "VLAD_HOME=D:\\my vlad"');
    expect(w.content).toContain('"C:\\n\\node.exe" "C:\\v\\dist\\cli.js" agent start');
    expect(w.file).toBe("D:\\my vlad\\.vlad-agent\\agent-start.cmd");
    expect(w.command).toContain(`"${w.file}"`);
    expect(w.command).not.toContain("agent start\"");
  });
});
