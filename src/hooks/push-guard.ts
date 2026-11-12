/** F-vlad-324: çalışan `git push` argv doğrulaması (saf). İzin glob'u (`vlad/*`) boşluk/`+`/çoklu ref'i yuttuğu için asıl kapı bu. */
const ID = /^T\d{8}-\d+$/;

/** Yalnız tek, tırnaksız, meta karaktersiz `git push [-u|--set-upstream] origin <ref>` geçer; ref kendi dalıdır. null = serbest, string = ret nedeni. */
export function checkWorkerPush(command: string, ownId: string | null): string | null {
  if (!/\bgit\s+(?:-\S+\s+(?:\S+\s+)?)*push\b/.test(command)) return null; // shortcut: alıntı içindeki "git push" da sayılır (korumacı)
  const deny = (why: string) => `çalışan push reddedildi: ${why} (izinli: git push [-u] origin vlad/<kendi-id> | HEAD:vlad/<kendi-id>)`;
  if (/[;&|`$()<>\n\r"'\\*?{}[\]]/.test(command)) return deny("kabuk meta karakteri / tırnak");
  const t = command.trim().split(/\s+/);
  if (t[0] !== "git" || t[1] !== "push") return deny("`git push` komutun başında olmalı");
  const a = t.slice(2);
  if (a[0] === "-u" || a[0] === "--set-upstream") a.shift();
  if (a.length !== 2) return deny("tam olarak `origin <ref>` bekleniyor");
  if (a[0] !== "origin") return deny("uzak yalnız origin");
  const m = /^(?:(HEAD|[0-9a-f]{7,40}|vlad\/(T\d{8}-\d+)):(?:refs\/heads\/)?)?vlad\/(T\d{8}-\d+)$/.exec(a[1]!);
  if (!m) return deny("ref biçimi geçersiz (+, :, başka dal, bayrak yok)");
  const dst = m[3]!;
  if (!ID.test(dst) || (ownId !== null && dst !== ownId)) return deny("yalnız kendi vlad/<id> dalı");
  if (m[2] && m[2] !== dst) return deny("kaynak ve hedef dal aynı olmalı");
  return null;
}
