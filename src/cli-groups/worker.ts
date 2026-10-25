import type { Command } from "commander";
import { def, type Opts } from "../cli-util.js";
import { tapStream } from "../tasks/index.js";

export function registerWorker(program: Command): void {
  const worker = program.command("worker").description("Çalışan süreç yardımcıları (iç kullanım)");
  def(worker, "tap <id>", "stdin'deki claude stream-json çıktısından session_id, son adım ve kota olayını görev dosyasına yazar", async (id: string, _o: Opts) => {
    await tapStream(id, process.stdin, { warn: (m) => process.stderr.write(`uyarı: ${m}\n`) });
  });
}
