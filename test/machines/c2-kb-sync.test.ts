import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kbSync } from "../../src/agent/ops/kb-sync.js";
import { makeHome, rmTemp } from "../helpers.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...a], { cwd, stdio: "pipe", encoding: "utf8" }).trim();

let base: string;
let brain: string;
let worker: string;
let home: string;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = { VLAD_HOME: process.env.VLAD_HOME, VLAD_KB_DIR: process.env.VLAD_KB_DIR, VLAD_MACHINE: process.env.VLAD_MACHINE };
  base = realpathSync(mkdtempSync(join(tmpdir(), "vlad-c2kb-")));
  const origin = join(base, "origin.git");
  mkdirSync(origin);
  git(origin, "init", "--bare", "-b", "main");
  brain = join(base, "brain-kb");
  git(base, "clone", "-q", origin, brain);
  git(brain, "checkout", "-q", "-b", "main");
  writeFileSync(join(brain, "a.md"), "1");
  git(brain, "add", "-A"); git(brain, "commit", "-q", "-m", "seed"); git(brain, "push", "-q", "-u", "origin", "main");
  worker = join(base, "worker-kb");
  git(base, "clone", "-q", origin, worker);
  home = makeHome();
  writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ brain: "mac", machines: [{ name: "mac", os: "darwin", agent: { port: 7437 } }, { name: "windows", os: "win32", agent: { host: "10.0.0.2", port: 7437 } }] }));
  process.env.VLAD_MACHINE = "windows";
  process.env.VLAD_KB_DIR = worker;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmTemp(base);
  rmTemp(home);
});

const push = (file: string) => { writeFileSync(join(brain, file), "x"); git(brain, "add", "-A"); git(brain, "commit", "-q", "-m", file); git(brain, "push", "-q"); return git(brain, "rev-parse", "HEAD"); };

describe("machines:C2 kb-sync (işçi)", () => {
  it("origin'deki yeni commit'i ff ile alır; head beklenen sha'nın soyundadır", async () => {
    const sha = push("b.md");
    const r = await kbSync({ expectSha: sha });
    expect(r.head).toBe(sha);
    expect(git(worker, "rev-parse", "HEAD")).toBe(sha);
  });

  it("beklenen sha origin'de yoksa failed", async () => {
    await expect(kbSync({ expectSha: "a".repeat(40) })).rejects.toMatchObject({ code: "failed" });
  });

  it("sha biçimi dışı (bayrak enjeksiyonu dâhil) bad_request; git çağrılmaz", async () => {
    for (const bad of ["--upload-pack=x", "abc", "G".repeat(40), "", 5, undefined]) {
      await expect(kbSync({ expectSha: bad })).rejects.toMatchObject({ code: "bad_request" });
    }
    await expect(kbSync(null)).rejects.toMatchObject({ code: "bad_request" });
  });

  it("işçi kb'si ayrışmışsa (yerel commit) failed; yerel commit kaybolmaz", async () => {
    writeFileSync(join(worker, "yerel.md"), "y"); git(worker, "add", "-A"); git(worker, "commit", "-q", "-m", "yerel");
    const local = git(worker, "rev-parse", "HEAD");
    const sha = push("c.md");
    await expect(kbSync({ expectSha: sha })).rejects.toMatchObject({ code: "failed" });
    expect(git(worker, "rev-parse", "HEAD")).toBe(local);
  });

  it("işçi kb ağacı kirli (izlenen dosya değişmiş) failed; dosya olduğu gibi kalır", async () => {
    writeFileSync(join(worker, "a.md"), "elle");
    const sha = push("d.md");
    await expect(kbSync({ expectSha: sha })).rejects.toMatchObject({ code: "failed", message: expect.stringContaining("kirli") });
    expect(git(worker, "show", "HEAD:a.md")).toBe("1");
  });

  it("izlenmeyen dosya (inbox/logs gibi yerel durum) kirli sayılmaz", async () => {
    writeFileSync(join(worker, "yerel-durum.txt"), "l");
    const sha = push("e.md");
    await expect(kbSync({ expectSha: sha })).resolves.toMatchObject({ head: sha });
  });

  it("yavaş fetch sürerken olay döngüsü serbest kalır (Agent ping cevaplanır)", async () => {
    const sha = push("slow.md");
    // fetch'in upload-pack adımı 1.5 sn uyur: eşzamanlı git bunca süre döngüyü dondururdu
    git(worker, "config", "remote.origin.uploadpack", "sleep 1.5; git-upload-pack");
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 20);
    const t0 = Date.now();
    try {
      const r = await kbSync({ expectSha: sha });
      expect(r.head).toBe(sha);
    } finally { clearInterval(timer); }
    const ms = Date.now() - t0;
    expect(ms).toBeGreaterThan(1200); // yavaşlatma gerçekten çalıştı
    expect(ticks).toBeGreaterThan(Math.floor(ms / 20 / 2)); // zamanlayıcı en az yarı hızda işledi
  });
});
