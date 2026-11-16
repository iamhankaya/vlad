import type { Command } from "commander";
import type { Kit } from "../kit.js";
import type { Opts } from "../ctx.js";

/**
 * Uzaktan onay servisi CLI'ı: SÖZLEŞME iskeleti (T20261116-04); gövdeler U4 (run/requests/show/rotate/unlock) ve U5 (install/uninstall).
 * Gizli çıktı (abonelik URL'si) yalnız stdout TTY ise basılır; `--json` bayrağı yok (install/uninstall/rotate/unlock/run). Her komut ayrı fonksiyon:
 * U5, U4 birleşmesinden sonra rebase eder ve yalnız kendi fonksiyonlarına dokunur.
 */
export interface ApproverCliDeps {
  /** install/uninstall/rotate/unlock için TTY denetimi (testte enjekte edilir). */
  isTTY?: () => boolean;
}

const todo = (name: string): never => { throw new Error(`not implemented: approver ${name}`); };

// --- U5 ---
function install(_o: Opts, _deps: ApproverCliDeps): void { todo("install"); }
function uninstall(_o: Opts, _deps: ApproverCliDeps): void { todo("uninstall"); }
// --- /U5 ---
// --- U4 ---
function rotate(_o: Opts, _deps: ApproverCliDeps): void { todo("rotate"); }
function unlock(_o: Opts, _deps: ApproverCliDeps): void { todo("unlock"); }
function status(_o: Opts): void { todo("status"); }
function requests(_o: Opts): void { todo("requests"); }
function show(_id: string, _o: Opts): void { todo("show"); }
function run(_o: Opts): void { todo("run"); }
// --- /U4 ---

export function registerApprover(program: Command, k: Kit, deps: ApproverCliDeps = {}): void {
  const { def } = k;
  const approver = program.command("approver").description("Uzaktan onay servisi (telefondan onay; yalnız macOS launchd)");
  def(approver, "install", "Servisi kurar: channel.json + launchd plist; gizli abonelik URL'sini yalnız TTY'ye basar (terminalde, mod yetkisiyle)", (o: Opts) => install(o, deps))
    .option("--server <url>", "ntfy sunucusu (https zorunlu; varsayılan https://ntfy.sh)");
  def(approver, "uninstall", "Servisi durdurur, plist'i ve approver/ altını siler (used/ ve mode.key'e dokunmaz)", (o: Opts) => uninstall(o, deps));
  def(approver, "rotate", "Yeni gizli istek konusu üretir, bekleyen isteği reddeder, yeni abonelik URL'sini TTY'ye basar", (o: Opts) => rotate(o, deps));
  def(approver, "unlock", "3 art arda ret/süre dolumu kilidini açar (TTY + mod yetkisi)", (o: Opts) => unlock(o, deps));
  def(approver, "status", "Servis durumu (salt okuma; konu/nonce/tag göstermez)", status);
  def(approver, "requests", "Son istekleri listeler (salt okuma)", requests)
    .option("--limit <n>", "en çok kaç kayıt");
  def(approver, "show <id>", "Tek isteğin ayrıntısı (salt okuma)", show);
  def(approver, "run", "Servis girişi (launchd girişi; elle çalıştırılmaz)", run);
}
