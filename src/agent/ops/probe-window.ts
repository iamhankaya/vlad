import { defaultExec } from "../../launcher/terminal.js";
import { RemoteError } from "../../fleet/types.js";

export const PROBE_TITLE = "VLAD probe-window";
type Exec = (file: string, args: string[], cwd?: string) => void | Promise<void>;

/** Sabit, zararsız, kendiliğinden kapanan pencere; argüman ya da kullanıcı girdisi yok. */
export function probeWindowCommand(): { file: string; args: string[] } {
  const script = `$host.UI.RawUI.WindowTitle = '${PROBE_TITLE}'; Write-Host 'VLAD Agent pencere denemesi: bu pencereyi gordunuz mu? 45 sn sonra kendiliginden kapanir.'; Start-Sleep -Seconds 45`;
  return { file: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script] };
}

/** Çalışan pencereyle aynı yolla (WMI, iş nesnesi dışı) görünür pencere açar; görünürlüğü kullanıcı doğrular. */
export async function probeWindow(o: { platform?: NodeJS.Platform; exec?: Exec } = {}): Promise<{ opened: boolean; method: string }> {
  if ((o.platform ?? process.platform) !== "win32") throw new RemoteError("failed", "failed: probe-window yalnız Windows'ta desteklenir");
  const { file, args } = probeWindowCommand();
  try {
    await (o.exec ?? defaultExec)(file, args);
  } catch (e) {
    throw new RemoteError("failed", `failed: pencere açılamadı: ${(e as Error).message}`);
  }
  return { opened: true, method: "wmi-powershell" };
}
