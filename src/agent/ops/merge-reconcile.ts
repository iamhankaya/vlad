import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { Reconciler, Verdict } from "../reconcile.js";
import { mergeCtx } from "./gate.js";

/**
 * `started` kalmış merge'ün etkisi var mı? Dal hedefin atasıysa uygulanmıştır (sonuç: güncel head);
 * değilse güvenle yeniden denenebilir (mergeOne kirli ağaç/yarım merge'ü kendi reddeder). Yarım merge (MERGE_HEAD) ya da git hatası → unknown.
 */
export function mergeVerdict(cwd: string, from: string, into: string): Verdict | { verdict: "applied"; result: unknown } {
  if (!existsSync(cwd)) return "unknown";
  const git = (...a: string[]) => spawnSync("git", a, { cwd, encoding: "utf8", windowsHide: true });
  if (git("branch", "--show-current").stdout?.trim() !== into) return "unknown"; // başka dalda: HEAD yanlış dalın head'i olur
  if (git("rev-parse", "--verify", "--quiet", "MERGE_HEAD").stdout.trim()) return "unknown";
  const anc = git("merge-base", "--is-ancestor", `refs/heads/${from}`, "HEAD");
  if (anc.status === 1) return "not-applied";
  const head = git("rev-parse", "HEAD");
  if (anc.status !== 0 || head.status !== 0) return "unknown";
  return { verdict: "applied", result: { head: head.stdout.trim(), merged: true } };
}

export const reconcileMerge: Reconciler = (rec) => {
  const { cwd, from, into } = mergeCtx(rec.args, ["message"]);
  return mergeVerdict(cwd, from, into);
};
