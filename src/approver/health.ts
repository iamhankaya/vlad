import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { launchdHome } from "../launchd-guard.js";
import { join } from "node:path";
import { approverDir as defaultApproverDir } from "../mode/token.js";

const LABEL = "com.vlad.approver";

export interface ServiceWarningDeps {
  platform?: NodeJS.Platform;
  approverDir?: string;
  plistDir?: string;
  /** launchd'de yüklü mü (varsayılan: `launchctl print`, salt okuma, 2 sn) */
  loaded?: () => boolean;
}

const launchdLoaded = (): boolean => {
  try { execFileSync("launchctl", ["print", `gui/${process.getuid?.() ?? 501}/${LABEL}`], { stdio: "ignore", timeout: 2000 }); return true; } catch { return false; }
};

/**
 * F-vlad-355 (c): approver yapılandırılmış (channel.json var) ama launchd servisi yoksa SessionStart özeti için tek satır uyarı.
 * Servis sessizce kalkarsa telefon onayı çalışmaz ve kimse fark etmez. Salt okuma; hata uyarıya dönüşmez (null).
 */
export function approverServiceWarning(d: ServiceWarningDeps = {}): string | null {
  try {
    if ((d.platform ?? process.platform) !== "darwin") return null;
    if (!existsSync(join(d.approverDir ?? defaultApproverDir(), "channel.json"))) return null; // approver hiç kurulmadı: uyarı yok
    const plist = join(d.plistDir ?? join(launchdHome(), "Library", "LaunchAgents"), `${LABEL}.plist`);
    if (!existsSync(plist)) return "approver servisi kurulu değil (kanal yapılandırılmış, plist yok): telefon onayı çalışmaz; terminalde vlad approver install";
    if (!(d.loaded ?? launchdLoaded)()) return "approver servisi launchd'de yüklü değil (plist var): telefon onayı çalışmaz; terminalde vlad approver install";
    return null;
  } catch { return null; }
}
