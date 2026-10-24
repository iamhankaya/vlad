import type { Command } from "commander";
import { def, defWrite, out, type Opts } from "../cli-util.js";
import { activeStatus, claimActive, heartbeatActive, releaseActive } from "../active/index.js";

export function registerActive(program: Command): void {
  const active = program.command("active").description("Etkin VLAD kaydı (kb/active.md)");
  def(active, "show", "Etkin VLAD'ı ve bayatlık durumunu gösterir", (o: Opts) => {
    const st = activeStatus();
    const a = st.record;
    out(
      o,
      { active: a, mine: st.mine, stale: st.stale, age_seconds: a ? Math.round(st.ageMs / 1000) : null, warnings: st.warnings },
      [
        a ? `etkin: ${a.machine}${st.mine ? " (bu makine)" : ""}  since ${a.since}  nabız ${a.heartbeat}${st.stale ? "  BAYAT" : ""}` : "etkin VLAD kaydı yok",
        ...st.warnings.map((w) => `uyarı: ${w}`),
      ].join("\n"),
    );
  });
  // these commands do their own active checks, so they bypass the generic guard
  defWrite(active, "claim", "Etkin VLAD rolünü alır; başka makine tazeyse active_elsewhere (--takeover ile devralır)", (o: Opts) => {
    const { record, warnings } = claimActive({ takeover: !!o.takeover });
    out(o, { active: record, warnings }, [`etkin VLAD: ${record.machine}`, ...warnings.map((w) => `uyarı: ${w}`)].join("\n"), );
  }, { guard: "off" }).option("--takeover", "başka makine tazeyken de devral");
  defWrite(active, "heartbeat", "Nabzı yeniler (en çok 30 dk'da bir yazar)", (o: Opts) => {
    const r = heartbeatActive();
    out(o, r, r.written ? `nabız yazıldı: ${r.record.heartbeat}` : "nabız taze; yazılmadı");
  }, { guard: "off" });
  defWrite(active, "release", "Etkin VLAD rolünü bırakır", (o: Opts) => {
    const released = releaseActive();
    out(o, { released }, released ? "etkin VLAD kaydı silindi" : "etkin VLAD kaydı yoktu");
  }, { guard: "off" });
}
