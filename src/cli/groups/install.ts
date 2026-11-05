import type { Command } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";
import { installGlobal } from "../../install.js";
import { getVladHome, loadConfig } from "../../kb/index.js";
import { selfName } from "../../agent/state.js";
import type { Kit } from "../kit.js";
import type { Opts } from "../ctx.js";

export function registerInstall(program: Command, k: Kit): void {
  const { ctx, out, def } = k;
  /** vlad install: sağ tık "Gönder" menüsü (aktarım). Tek karşı makine yoksa atlanır; --dry-run hiçbir şeye dokunmaz. */
  async function sendMenuActions(dryRun: boolean, uninstall = false): Promise<string[]> {
    let cfg: ReturnType<typeof loadConfig>;
    try { cfg = loadConfig(); } catch { return ["sağ tık menüsü atlandı: yapılandırma okunamadı"]; }
    if (!cfg.machines) return ["sağ tık menüsü atlandı: machines yok"];
    let self: string;
    try { self = selfName(); } catch { return ["sağ tık menüsü atlandı: makine kimliği belirsiz (VLAD_MACHINE / vlad.local.json self)"]; }
    const others = cfg.machines.filter((m) => m.name !== self);
    const me = cfg.machines.find((m) => m.name === self);
    if (!me || others.length !== 1) return ["sağ tık menüsü atlandı: karşı makine tek değil"];
    const { installSendMenu } = await import("../../menu/index.js");
    const servicesDir = ctx.env.VLAD_SERVICES_DIR || join(homedir(), "Library", "Services");
    return (await installSendMenu({ os: me.os, node: process.execPath, cli: ctx.cliPath, home: getVladHome(), peer: others[0]!.name, servicesDir, dryRun, uninstall, self, userProfile: ctx.env.USERPROFILE })).actions;
  }

  def(program, "install", "SessionEnd hook'unu ve vlad-worker skill'ini ~/.claude'a kurar", async (o: Opts) => {
    const claudeDir = ctx.env.VLAD_CLAUDE_DIR || join(homedir(), ".claude");
    const actions = o.removeMenu ? [] : installGlobal({ home: getVladHome(), claudeDir, dryRun: !!o.dryRun }).actions;
    actions.push(...(await sendMenuActions(!!o.dryRun, !!o.removeMenu)));
    out(o, { actions }, actions.join("\n"));
  }).option("--dry-run", "hiçbir şeye dokunmadan yapılacakları göster").option("--remove-menu", "yalnız sağ tık \"gönder\" menüsünü kaldırır (geri alma)");
}
