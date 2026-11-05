/** F-vlad-247: resume always names its session; `--continue` could pick any session of the folder (F-vlad-097), so no id is an error. */
export function resumeFlags(sessionId: string | null | undefined): string[] {
  if (!sessionId) throw new Error("oturum kimliği yok: --continue kullanılmaz; taze oturum başlat ya da kimliği ver");
  // F-vlad-257: the id comes from the kb record and lands on a command line
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error("oturum kimliği geçersiz: yalnız harf, rakam, - ve _");
  return ["--resume", sessionId];
}
