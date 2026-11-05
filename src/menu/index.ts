import type { Os } from "../machines/types.js";
import type { ShellRunner } from "../clip/types.js";

// Sözleşme (S) → gövde C (win.ts / mac.ts). Gerçek `reg`/`pbs` çalıştırıcısı VLAD_NO_NATIVE=1 iken çalışmaz.
export interface MenuCtx { os: Os; node: string; cli: string; home: string; peer: string; servicesDir: string; dryRun: boolean }
type Mc = Pick<MenuCtx, "node" | "cli" | "home" | "peer">;
export function winMenuRegCommands(_c: Mc): { file: string; args: string[] }[] { throw new Error("henüz gerçeklenmedi: winMenuRegCommands"); }
export function winHiddenLauncher(_c: Mc): { file: string; content: string; encoding: "utf16le-bom" } { throw new Error("henüz gerçeklenmedi: winHiddenLauncher"); }
export function macQuickAction(_c: Mc): { dir: string; files: { rel: string; content: string }[] } { throw new Error("henüz gerçeklenmedi: macQuickAction"); }
/** S stub'ı: eylem üretmez (vlad install testleri kırılmasın); C gövdeyi yazar. */
export async function installSendMenu(_c: MenuCtx, _d: { run?: ShellRunner; write?: (f: string, content: string | Buffer) => Promise<void>; exists?: (f: string) => Promise<boolean> } = {}): Promise<{ actions: string[] }> {
  return { actions: [] };
}
