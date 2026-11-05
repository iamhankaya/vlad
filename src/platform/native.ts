// Sözleşme (aktarım S): gerçek pano / bildirim / yardımcı süreç çağrılarının tek kapısı.
// Testlerde VLAD_NO_NATIVE=1 (vitest.config.ts + test/isolate-env.ts); gerçek pano ve bildirime asla dokunulmaz.
export class NativeDisabledError extends Error {
  constructor(what: string) { super(`native devre dışı (VLAD_NO_NATIVE=1): ${what}`); this.name = "NativeDisabledError"; }
}
export function nativeAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VLAD_NO_NATIVE !== "1";
}
export function assertNative(what: string): void {
  if (!nativeAllowed()) throw new NativeDisabledError(what);
}
