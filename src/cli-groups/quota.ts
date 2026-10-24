import type { Command } from "commander";
import { def, defWrite, out, type Opts } from "../cli-util.js";
import { clearQuota, readQuota, setQuota } from "../quota/index.js";

export function registerQuota(program: Command): void {
  const quota = program.command("quota").description("Abonelik kota işareti (kb/logs/quota.json)");
  defWrite(quota, "set", "Kota sınırını işaretler; bitene kadar yeni faz başlamaz", (o: Opts) => {
    if (!o.until || !o.reason) throw new Error("--until ve --reason gerekli");
    const rec = setQuota(o.until as string, o.reason as string);
    out(o, rec, `kota işaretlendi: ${rec.limited_until} (${rec.reason})`);
  })
    .option("--until <iso>", "sınırın biteceği zaman (ISO 8601)")
    .option("--reason <metin>", "neden (ör. görev ID'si)");
  def(quota, "show", "Geçerli kota durumunu gösterir", (o: Opts) => {
    const { quota: q, record, warnings } = readQuota();
    out(
      o,
      { limited: q.limited, until: q.until ?? null, reason: record?.reason ?? null, at: record?.at ?? null, warnings },
      [
        q.limited ? `sınırda: ${q.until} (${record?.reason})` : "sınır yok",
        ...warnings.map((w) => `uyarı: ${w}`),
      ].join("\n"),
    );
  });
  defWrite(quota, "clear", "Kota işaretini siler", (o: Opts) => {
    const removed = clearQuota();
    out(o, { cleared: removed }, removed ? "kota işareti silindi" : "kota işareti yoktu");
  });
}
