/**
 * SÖZLEŞME iskeleti (gövde U5'te). macOS launchd; yalnız `approver` CLI grubunda dinamik `import()` ile yüklenir (Windows testini kırmaz).
 * Plist: `com.vlad.approver`, `RunAtLoad`, `KeepAlive`, `ThrottleInterval 10`; `AbandonProcessGroup` YOK (mevcut agent plist'inin `true`'su kopyalanmaz).
 * Kısmi kurulum (plist yazıldı, bootstrap başarısız) geri alınır. Stub `approver run` ile gerçek `install` ASLA denenmez (KeepAlive döngüsü).
 */
export interface ServiceInstaller {
  install(c: { node: string; cli: string; home: string; path: string }): Promise<string[]>;
  uninstall(): Promise<string[]>;
  status(): Promise<{ installed: boolean; running: boolean; detail: string }>;
}
/** `launchctl` çağrıcısı enjekte edilebilir (testte sahte). */
export type Launchctl = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export function createLaunchdInstaller(deps: { launchctl?: Launchctl; plistDir?: string } = {}): ServiceInstaller { void deps; throw new Error("not implemented"); }
