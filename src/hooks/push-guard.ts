/** F-vlad-324: çalışan `git push` argv doğrulaması (saf). İzin glob'u (`vlad/*`) boşluk/`+`/çoklu ref'i yuttuğu için asıl kapı bu. */
const ID = /^T\d{8}-\d+$/;
const DENY_HINT = "(izinli: git push [-u] origin vlad/<kendi-id> | HEAD:vlad/<kendi-id>)";
const deny = (why: string) => `çalışan push reddedildi: ${why} ${DENY_HINT}`;

/** `git` komut konumunda mı (env öneki/`command`/yol önekli ya da alıntılı biçimler dahil)? Alt komutu döndürür. */
function gitSubcommand(t: string[]): { sub: string | null; plain: boolean; rest: string[] } | null {
  let i = 0;
  while (i < t.length && /^\w+=/.test(t[i]!)) i++;
  const head = (t[i] ?? "").replace(/^["'\\]+|["']+$/g, "");
  if (head === "command" || head === "exec" || head === "env") return gitSubcommand(t.slice(i + 1));
  if (!/(^|\/)git(\.exe)?$/.test(head.replace(/\\/g, ""))) return null;
  const plain = i === 0 && t[0] === "git";
  let j = i + 1;
  while (j < t.length && t[j]!.startsWith("-")) j += /^-[Cc]$|^--(git-dir|work-tree|namespace)$/.test(t[j]!) ? 2 : 1;
  return { sub: t[j] ?? null, plain, rest: t.slice(j + 1) };
}

/** Yalnız tek, tırnaksız, meta karaktersiz `git push [-u|--set-upstream] origin <ref>` geçer; ref kendi dalıdır. null = serbest, string = ret nedeni. */
export function checkWorkerPush(command: string, ownId: string | null): string | null {
  // Komut ikamesi/alt kabuk içindeki push, segment bölmesinde kaybolmasın.
  if (/(\$\(|`|\bsh\s+-c|\bbash\s+-c|\beval\b)/.test(command) && /\bgit\b[^\n]*\bpush\b/.test(command)) return deny("komut ikamesi/alt kabukta git push");
  for (const seg of command.split(/&&|\|\||[;|\n]/)) {
    const t = seg.trim().split(/\s+/).filter(Boolean);
    const g = t.length ? gitSubcommand(t) : null;
    if (!g) continue;
    if (/\balias\./.test(seg)) return deny("git alias ayarı");
    if (g.sub !== "push") continue; // shortcut: kullanıcı tanımlı alias (`git p`) kalıp/izin glob'una bırakılır
    if (!g.plain) return deny("`git push` düz biçimde (env/yol/`command` öneksiz) olmalı");
    if (/[<>$"'\\*?{}()[\]]/.test(seg.replace(/\s2>&1(\s|$)/g, " "))) return deny("kabuk meta karakteri / tırnak");
    const a = g.rest.filter((x) => x !== "2>&1");
    if (a[0] === "-u" || a[0] === "--set-upstream") a.shift();
    if (a.length !== 2) return deny("tam olarak `origin <ref>` bekleniyor");
    if (a[0] !== "origin") return deny("uzak yalnız origin");
    const m = /^(?:(HEAD|[0-9a-f]{7,40}|vlad\/(T\d{8}-\d+)):(?:refs\/heads\/)?)?vlad\/(T\d{8}-\d+)$/.exec(a[1]!);
    if (!m) return deny("ref biçimi geçersiz (+, :, başka dal, bayrak yok)");
    const dst = m[3]!;
    if (!ID.test(dst) || (ownId !== null && dst !== ownId)) return deny("yalnız kendi vlad/<id> dalı");
    if (m[2] && m[2] !== dst) return deny("kaynak ve hedef dal aynı olmalı");
  }
  return null;
}
