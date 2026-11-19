import { appendFileSync } from "node:fs";
import { cpus } from "node:os";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";
import type { Reporter, TestModule } from "vitest/node";

// F-vlad-121 measurement: records every red test of a run as one JSONL row so intermittent failures leave a name behind.
// No retry on purpose (it would hide the red). Must never change the run: every failure here is swallowed.
const ROOT = join(import.meta.dirname, "..", "..");

function sha(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

export default class FlakyReporter implements Reporter {
  private file: string;
  private maxWorkers = Math.max(2, Math.floor(cpus().length / 2));
  private root = ROOT;
  constructor(opts: { file?: string } = {}) {
    this.file = opts.file ?? join(ROOT, ".vitest-red.jsonl");
  }

  onInit(vitest: { config?: { root?: string; maxWorkers?: number } }): void {
    try {
      if (vitest.config?.root) this.root = vitest.config.root;
      if (typeof vitest.config?.maxWorkers === "number") this.maxWorkers = vitest.config.maxWorkers;
    } catch { /* measurement only */ }
  }

  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    try {
      const rows: string[] = [];
      let commit: string | undefined;
      for (const mod of testModules) {
        for (const t of mod.children.allTests("failed")) {
          const err = (t.result() as { errors?: Array<{ message?: string }> }).errors?.[0];
          const full = String(err?.message ?? "");
          commit ??= sha();
          rows.push(JSON.stringify({
            file: relative(this.root, mod.moduleId).split("\\").join("/"),
            name: t.fullName,
            durationMs: Math.round(t.diagnostic()?.duration ?? 0),
            timedOut: /timed out in \d+ms/i.test(full),
            error: full.split("\n")[0].slice(0, 300),
            sha: commit,
            at: new Date().toISOString(),
            maxWorkers: this.maxWorkers,
          }));
        }
      }
      if (rows.length) appendFileSync(this.file, rows.join("\n") + "\n");
    } catch { /* never affect the run's exit code */ }
  }
}
