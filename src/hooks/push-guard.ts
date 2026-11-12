/** F-vlad-324: çalışan `git push` doğrulaması (saf). Katı tam-komut kalıbı: kabuk ayrıştırma yok, `git` ve `push` birlikte geçen her komut ya kalıba tam uyar ya reddedilir. */
const ALLOWED = /^(?:cd [^\s;&|$`"'()<>*?{}\\]+ && )?git push(?: -u| --set-upstream)? origin vlad\/(T\d{8}-\d+)(?: 2>&1)?$/;

/** null = serbest, string = ret nedeni. shortcut: "git" ve "push" kelimeleri birlikte geçen her komut (commit mesajı dahil) reddedilir; çalışan `git commit -F <dosya>` kullanır. */
export function checkWorkerPush(command: string, ownId: string | null): string | null {
  const c = command.replace(/\\\r?\n/g, "").trim(); // satır devamı: bash birleştirir
  const bare = c.replace(/["'\\]/g, ""); // `p\ush`, `pu""sh`, `g'it'` kelime olarak aranır
  if (!/\bgit\b/.test(bare) || !/\bpush\b/.test(bare)) return null; // shortcut: değişken/ikame ile kurulan "push" (git $(echo pu)sh) kelime olarak görünmez; hook yanında glob deny katmanı kalır
  const m = ALLOWED.exec(c);
  if (!m) return "çalışan push reddedildi: komut tam kalıba uymuyor (izinli: [cd <dizin> && ]git push [-u] origin vlad/<kendi-id> [2>&1]; commit mesajında git+push geçiyorsa `git commit -F <dosya>`)";
  if (ownId !== null && m[1] !== ownId) return "çalışan push reddedildi: yalnız kendi vlad/<id> dalı";
  return null;
}
