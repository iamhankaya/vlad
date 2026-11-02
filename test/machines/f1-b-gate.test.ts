import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkMergeRefs, runGate, validParent } from "../../src/agent/ops/gate.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...a], { cwd, stdio: "pipe", encoding: "utf8" }).trim();
const tmpRepo = () => {
  const d = mkdtempSync(join(tmpdir(), "vlad-f1b-"));
  git(d, "init", "-b", "main");
  writeFileSync(join(d, "a.txt"), "1");
  git(d, "add", ".");
  git(d, "commit", "-m", "first");
  return d;
};

describe("F-vlad-138/139: runGate", () => {
  it("F-138: gate stdin'i kapalı (girdi bekleyen gate EOF alır, asılmaz)", async () => {
    const d = tmpRepo();
    const r = await runGate(`node -e "process.stdin.on('end',()=>console.log('eof'));process.stdin.resume()"`, d);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("eof");
  }, 15_000);

  it("F-139: sonuç, gate'in koştuğu HEAD sha'sını taşır", async () => {
    const d = tmpRepo();
    const r = await runGate(`node -e "0"`, d);
    expect(r.head).toBe(git(d, "rev-parse", "HEAD"));
  }, 15_000);

  it("F-154: gate commit atarsa sonuç tutarsızlığı bildirir (yeşil sayılmaz)", async () => {
    const d = tmpRepo();
    const before = git(d, "rev-parse", "HEAD");
    const r = await runGate(`git -c user.name=T -c user.email=t@t commit --allow-empty -m gate`, d);
    const after = git(d, "rev-parse", "HEAD");
    expect(after).not.toBe(before);
    expect(r.headBefore).toBe(before);
    expect(r.head).toBe(after);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toContain("HEAD değişti");
  }, 15_000);

  it.skipIf(process.platform === "win32")("F-137: POSIX'te zaman aşımı süreç ağacını (torunu) öldürür", async () => {
    const d = tmpRepo();
    const marker = join(d, "alive.txt");
    const r = await runGate(`sh -c "sleep 3; echo x > ${marker}" & wait`, d, 300);
    expect(r.exit).toBe(124);
    await new Promise((res) => setTimeout(res, 3500));
    expect(() => execFileSync("test", ["-e", marker])).toThrow();
  }, 15_000);
});

describe("F-vlad-140: doğrulamalar", () => {
  it("validParent: çatı kimliği TASK_ID biçiminde olmalı; boş/null kabul", () => {
    expect(() => validParent("T20261101-19")).not.toThrow();
    expect(() => validParent(null)).not.toThrow();
    expect(() => validParent(undefined)).not.toThrow();
    expect(() => validParent("../x")).toThrow(/bad_request/);
    expect(() => validParent(5 as never)).toThrow(/bad_request/);
  });

  it("geçersiz ref adları (git kuralları) ana dal olarak reddedilir", () => {
    const root = { id: "T20261101-19", parent: null };
    for (const b of ["a..b", "a//b", "a.lock", "a/b.lock", "a/", "a@{1}", "a b", "a~1", "a^", "a:b", "a?", "a*", "a[", "a\b", ".a", "a/.b", "a."]) {
      expect(() => checkMergeRefs({ ...root, defaultBranch: b }, "vlad/T20261101-19", b), b).toThrow(/bad_request/);
    }
    expect(() => checkMergeRefs({ ...root, defaultBranch: "release/1.2" }, "vlad/T20261101-19", "release/1.2")).not.toThrow();
  });
});
