import { homedir } from "node:os";
import { join } from "node:path";
import { PairingCodes } from "./auth/pairing.ts";

const stateDir = process.env.VLAD_SERVER_STATE_DIR ?? join(homedir(), ".vlad-server");
const [cmd] = process.argv.slice(2);

if (cmd === "pair") {
  const { code, expires } = new PairingCodes(stateDir, Date.now).issue();
  console.log(`Eşleştirme kodu: ${code}`);
  console.log(`Geçerlilik: 10 dk (${new Date(expires).toISOString()}), tek kullanım, 5 yanlışta yanar.`);
} else if (cmd === "kb-promote") {
  // One promote cycle (vlad-kbpromote.timer, user `vladapi`). Handled outcomes exit 0 and print the result as JSON; only an unexpected git failure exits 1.
  const { AppTokenProvider, loadAppKey } = await import("./github/appToken.ts");
  const { GithubClient } = await import("./github/client.ts");
  const { assertKbRepoIsNotCodeRepo, buildKbGate, loadKbSyncConfig, projectRepos } = await import("./kbsync/config.ts");
  const { settlePendingTakeover } = await import("./kbsync/takeover.ts");
  const cfg = loadKbSyncConfig(process.env, stateDir);
  const appId = process.env.VLAD_GITHUB_APP_ID;
  const key = loadAppKey(process.env, stateDir);
  if (!cfg || !appId || !key) {
    console.error("kb-promote için VLAD_KB_REPO, VLAD_GITHUB_APP_ID ve App anahtarı gerekli");
    process.exit(2);
  }
  assertKbRepoIsNotCodeRepo(cfg.repo, await projectRepos());
  const tokens = new AppTokenProvider({ appId, privateKey: key, installationId: process.env.VLAD_GITHUB_APP_INSTALLATION_ID });
  const gate = await buildKbGate({ config: cfg, tokens, client: new GithubClient({ tokens }) });
  const result = await gate.promote({ trigger: "timer" });
  await settlePendingTakeover(gate.takeoverDeps, result);
  console.log(JSON.stringify(result));
  process.exit(result.reason === "git_error" ? 1 : 0);
} else {
  console.error("Kullanım: vlad-server pair | kb-promote");
  process.exit(cmd ? 2 : 0);
}
