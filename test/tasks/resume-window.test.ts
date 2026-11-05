// F-vlad-202: yerel `task resume` (Mac/Linux) yalnız prompt basmaz; launch gibi pencere/tmux oturumu açar.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { NO_CLOUD_ENV, newTask, vlad, writeCard } from "../acceptance/cloud-helpers.js";
import { makeHome } from "../helpers.js";

let home: string;
let log: string;
let id: string;
let wt: string;
beforeEach(() => {
  home = makeHome();
  const base = mkdtempSync(join(tmpdir(), "vlad-rw-"));
  log = join(base, "noop.jsonl");
  wt = join(base, "repo");
  mkdirSync(wt);
  const git = (...x: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...x], { cwd: wt, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(wt, "a.txt"), "1");
  git("add", "."); git("commit", "-q", "-m", "i");
  writeCard(home, "alpha");
  id = newTask(home);
  git("checkout", "-q", "-b", `vlad/${id}`);
  expect(vlad(home, ["task", "set", id, "running"], { env: NO_CLOUD_ENV }).code).toBe(0);
  const f = join(home, "kb", "tasks", `${id}.md`);
  writeFileSync(f, readFileSync(f, "utf8").replace(/^worktree: .*$/m, `worktree: ${JSON.stringify(wt)}`));
});
const env = () => ({ ...NO_CLOUD_ENV, VLAD_NOOP_LOG: log, VLAD_DESKTOP_QUEUE: undefined });

describe("task resume (yerel)", () => {
  it.skipIf(process.platform === "win32")("launcher ile pencere/oturum açar; çıktı method içerir", () => {
    const r = vlad(home, ["task", "resume", id, "--json"], { env: env() });
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out);
    expect(j).toMatchObject({ mode: "local", method: "noop" });
    expect(existsSync(log)).toBe(true);
    const lines = readFileSync(log, "utf8").trim().split("\n").map((x) => JSON.parse(x));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ taskId: id, cwd: wt });
  });
  it("--external pencere açmaz (betik yazar)", () => {
    const r = vlad(home, ["task", "resume", id, "--external", "--json"], { env: env() });
    expect(r.code, r.err).toBe(0);
    expect(existsSync(log)).toBe(false);
  });
});
