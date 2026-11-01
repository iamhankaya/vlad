import { spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { makeHome } from "../helpers.js";

const cli = resolve(import.meta.dirname, "..", "..", "dist", "cli.js");
let home: string;
beforeEach(() => { home = makeHome(); });

function vlad(args: string[], input = "", env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((done) => {
    const p = spawn("node", [cli, ...args], { env: { ...process.env, VLAD_HOME: home, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => done({ code, out, err }));
    p.stdin.end(input);
  });
}

const CARD = `---
slug: alpha
name: Alpha
path: "C:\\\\x"
stack: [ts]
status: active
autonomy: commit
last_activity: null
last_scanned: null
---

## Özet
x
`;

describe("kb yazma kilidi: eşzamanlı süreçler (F-vlad-096)", { timeout: 120_000 }, () => {
  it("journal append, task log ve finding add ayrı süreçlerden eşzamanlı çalışınca kayıp ve çift ID olmaz", async () => {
    writeFileSync(join(home, "card.md"), CARD);
    expect((await vlad(["project", "write", "alpha", "--file", join(home, "card.md")])).code).toBe(0);
    const id = JSON.parse((await vlad(["task", "new", "--project", "alpha", "--title", "T", "--kind", "dev", "--body-file", "-", "--json"], "## Tanım\nx\n")).out).id as string;

    process.env.VLAD_LOCK_TIMEOUT_MS = "120000"; // yük altında bekleme payı
    const WORKERS = 4, ROUNDS = 6;
    const ids: string[] = [];
    const failures: string[] = [];
    const worker = async (w: number) => {
      for (let i = 0; i < ROUNDS; i++) {
        const tag = `w${w}-i${i}`;
        const rs = [
          await vlad(["journal", "append", "2026-11-01", "--file", "-"], `## alpha\n- ${tag}\n`),
          await vlad(["task", "log", id, `log-${tag}`]),
          await vlad(["finding", "add", "--project", "alpha", "--severity", "düşük", "--source", id, "--title", `f-${tag}`, "--json"]),
        ];
        for (const r of rs) if (r.code !== 0) failures.push(r.err.trim());
        if (rs[2].code === 0) ids.push(JSON.parse(rs[2].out).id);
      }
    };
    await Promise.all(Array.from({ length: WORKERS }, (_, w) => worker(w)));

    const n = WORKERS * ROUNDS;
    expect(failures).toEqual([]);
    expect(new Set(ids).size).toBe(n);
    expect(readdirSync(join(home, "kb", "findings")).filter((f) => f.endsWith(".md"))).toHaveLength(n);
    const journal = readFileSync(join(home, "kb", "journal", "2026-11-01.md"), "utf8");
    expect(journal.match(/- w\d+-i\d+/g)).toHaveLength(n);
    const task = readFileSync(join(home, "kb", "tasks", `${id}.md`), "utf8");
    expect(task.match(/log-w\d+-i\d+/g)).toHaveLength(n);
  });

  it("kilit tutulurken yazan komut zaman aşımında JSON hata + çıkış 1 verir; okuma komutları ve kb commit beklemez", async () => {
    writeFileSync(join(home, "card.md"), CARD);
    await vlad(["project", "write", "alpha", "--file", join(home, "card.md")]);
    const id = JSON.parse((await vlad(["task", "new", "--project", "alpha", "--title", "T", "--kind", "dev", "--body-file", "-", "--json"], "## Tanım\nx\n")).out).id as string;
    writeFileSync(join(home, "kb", ".vlad.lock"), JSON.stringify({ pid: process.pid, started: Date.now(), token: "test" })); // canlı sahip: bu test süreci
    const env = { VLAD_LOCK_TIMEOUT_MS: "300" };

    const w = await vlad(["task", "log", id, "x", "--json"], "", env);
    expect(w.code).toBe(75);
    expect(JSON.parse(w.err).error).toMatch(/^kb kilidi alınamadı/);
    expect((await vlad(["task", "list", "--json"], "", env)).code).toBe(0);
    expect((await vlad(["status", "--no-mark", "--json"], "", env)).code).toBe(0);
    expect((await vlad(["status", "--json"], "", env)).code).toBe(0); // kilitliyken yazmadan okuma moduna düşer (SessionStart hook'u bloklanmaz)
    expect((await vlad(["project", "list", "--json"], "", env)).code).toBe(0);
    expect((await vlad(["kb", "commit", "x"], "", env)).err).not.toMatch(/kilid/); // git yok/kb repo değil: başka hata olabilir, kilit hatası olmamalı
  });
});
