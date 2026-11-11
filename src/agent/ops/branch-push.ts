import { BRANCH_PUSH_BRANCH_RE, type BranchPushArgs } from "../../fleet/types.js";
import { argObject, bad, projectArg, repoNameArg, taskIdArg } from "./worker.js";

// `branch-push` (F-vlad-314, sözleşme T20261111-50): yalnız argüman şekli. Gövde (taskFront/verifiedRecord, ls-remote, push) uygulama fazındadır.
// Push argv'sinde `+`/force/tags/mirror/all/delete asla yok: hedef `origin <expectHead>:refs/heads/vlad/<id>`.

/** İstek şeması: yalnız bu 5 alan; branch tam `vlad/<taskId>`; expectHead 40 haneli küçük harf sha. */
export function parseBranchPushArgs(args: unknown): BranchPushArgs {
  const a = argObject(args, ["taskId", "project", "repoName", "branch", "expectHead"]);
  const taskId = taskIdArg(a);
  const project = projectArg(a);
  const repoName = repoNameArg(a);
  if (typeof a.branch !== "string" || !BRANCH_PUSH_BRANCH_RE.test(a.branch) || a.branch !== `vlad/${taskId}`) throw bad("branch görevin kendi dalı (vlad/<taskId>) olmalı");
  if (typeof a.expectHead !== "string" || !/^[0-9a-f]{40}$/.test(a.expectHead)) throw bad("expectHead 40 haneli sha olmalı");
  return { taskId, project, repoName, branch: a.branch, expectHead: a.expectHead };
}
