/** F-vlad-247: resume always names its session; `--continue` could pick any session of the folder (F-vlad-097), so no id is an error. */
export function resumeFlags(sessionId: string | null | undefined): string[] {
  if (!sessionId) throw new Error("oturum kimliği yok: --continue kullanılmaz; taze oturum başlat ya da kimliği ver");
  return ["--resume", sessionId];
}
