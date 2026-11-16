import { describe, expect, it } from "vitest";
import { checkWorkerMode } from "../../src/hooks/mode-guard.js";
import { secretDir } from "../../src/mode/token.js";

// Pozitif hook testi: gizli dizin öneki `approver/` ve `used/` yollarını da kapsar (hook en iyi çaba katmanı).
const ctx = { vladHome: "/home/u/vlad", cwd: "/work/wt" };
const kb = "/home/u/vlad-kb";
const reason = /\(anahtar: /;
describe("approver sözleşmesi: mode-guard approver/ ve used/ yollarını engeller", () => {
  const home = ["~/.vlad-secret/approver/channel.json", "~/.vlad-secret/approver/inbox/x.json", "~/.vlad-secret/used/1.abc"];
  const tmp = [`${secretDir()}/approver/pending.json`, `${secretDir()}/used/1.abc`];
  it("Edit/Write: gerçek ve test gizli dizini altındaki yollar reddedilir", () => {
    for (const p of [...home, ...tmp]) expect(checkWorkerMode("Write", { file_path: p }, kb, ctx), `Write ${p}`).toMatch(reason);
  });
  it("Bash (okuma dahil): `~/.vlad-secret` öneki reddedilir", () => {
    for (const p of home) expect(checkWorkerMode("Bash", { command: `cat ${p}` }, kb, ctx), `cat ${p}`).toMatch(reason);
  });
});
