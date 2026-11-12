/** F-vlad-324: çalışan `git push` argv doğrulaması (saf). İzin glob'u (`vlad/*`) boşluk/`+`/çoklu ref'i yuttuğu için asıl kapı bu. */
const DENY_HINT = "(izinli: git push [-u] origin vlad/<kendi-id>)";
const deny = (why: string) => `çalışan push reddedildi: ${why} ${DENY_HINT}`;

interface Tok { v: string; quoted: boolean }
/** Tırnak-bilinçli bölme: ayraçlar (`&&`,`||`,`;`,`|`,`&`,satır sonu,`(`,`)`) yalnız tırnak dışında segment keser; token değeri tırnaksızdır. */
function segments(cmd: string): Tok[][] {
  const out: Tok[][] = [[]];
  let cur = "", q = false, open: string | null = null;
  const flush = () => { if (cur !== "" || q) out[out.length - 1]!.push({ v: cur, quoted: q }); cur = ""; q = false; };
  const cut = () => { flush(); if (out[out.length - 1]!.length) out.push([]); };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (c === "\\" && (cmd[i + 1] === "\n" || (cmd[i + 1] === "\r" && cmd[i + 2] === "\n"))) { i += cmd[i + 1] === "\r" ? 2 : 1; continue; } // satır devamı: bash birleştirir (tırnak içinde de)
    if (open) { if (c === open) open = null; else if (c === "\\" && open === '"' && i + 1 < cmd.length) cur += cmd[++i]!; else cur += c; continue; }
    if (c === "'" || c === '"') { open = c; q = true; continue; }
    if (c === "\\" && i + 1 < cmd.length) { cur += cmd[++i]!; q = true; continue; }
    if (/\s/.test(c)) { if (c === "\n") cut(); else flush(); continue; }
    if (c === "&" || c === "|" || c === ";" || c === "(" || c === ")") { if (cmd[i + 1] === c && c !== ";" && c !== "(" && c !== ")") i++; cut(); continue; }
    cur += c;
  }
  flush();
  return out.filter((s) => s.length);
}

/** Segmentte `git` token'ı (yol/`.exe` önekli olabilir) ve ondan sonraki ilk alt komut. Belirsizlikte (git öncesi sarmalayıcı) `wrapped`. */
function findGit(s: Tok[]): { at: number; sub: number } | null {
  const at = s.findIndex((t) => /(^|[\/\\])git(\.exe)?$/.test(t.v));
  if (at < 0) return null;
  let j = at + 1;
  while (j < s.length && s[j]!.v.startsWith("-")) j += /^-[Cc]$|^--(git-dir|work-tree|namespace|exec-path|config-env)$/.test(s[j]!.v) ? 2 : 1;
  return { at, sub: j };
}

/** Yalnız tek `git push [-u|--set-upstream] origin vlad/<kendi-id>` geçer. null = serbest, string = ret nedeni. */
export function checkWorkerPush(command: string, ownId: string | null): string | null {
  // Komut ikamesi / alt kabuk / eval içindeki push segment bölmesinde kaybolmasın (shortcut: heredoc commit mesajında "git push …" geçerse de reddedilir; -F kullanın).
  if (/(\$\(|`|\b(?:ba|z|da|k)?sh\s+-\w*c|\beval\b)/.test(command) && /\bgit\b[^\n]*\bpush\b/.test(command)) return deny("komut ikamesi/alt kabukta git push");
  command = command.replace(/\s\d?>&\d(?=\s|$)/g, " ").replace(/\s\d?>\s*\/dev\/null(?=\s|$)/g, " "); // zararsız yönlendirmeler
  for (const s of segments(command)) {
    const g = findGit(s);
    if (!g) continue;
    // Yalnız alias YAZAN biçimler: `git -c alias.x=…`, `--config-env=alias.x=…`, `git config … alias.x` (commit mesajı/--grep içindeki "alias." yanlış pozitif olmasın).
    const globals = s.slice(g.at + 1, g.sub).map((t) => t.v);
    if (globals.some((v, k) => (v === "-c" && /^alias\./i.test(globals[k + 1] ?? "")) || /^(?:-c|--config-env=)alias\./i.test(v))) return deny("git alias ayarı");
    if (s[g.sub]?.v === "config" && !s.some((t) => /^(--get(-all|-regexp)?|--list|-l|--unset(-all)?)$/.test(t.v)) && s.slice(g.sub + 1).some((t) => /^alias\./i.test(t.v))) return deny("git alias ayarı");
    if (s[g.sub]?.v !== "push") continue; // shortcut: kullanıcı tanımlı alias (`git p`) kalıp/izin glob'una bırakılır
    if (g.at !== 0 || s[0]!.v !== "git" || s[0]!.quoted) return deny("`git push` düz biçimde (sarmalayıcı/env/yol/tırnaklı git öneksiz) olmalı");
    if (g.sub !== 1) return deny("git global seçeneği (-c/-C/--git-dir/…) ile push yok");
    if (s.some((t) => t.quoted)) return deny("tırnak/kaçış");
    if (s.some((t) => /[<>$*?{}[\]]/.test(t.v))) return deny("kabuk meta karakteri");
    const a = s.slice(2).map((t) => t.v).filter((x) => x !== "2>&1");
    if (a[0] === "-u" || a[0] === "--set-upstream") a.shift();
    if (a.length !== 2) return deny("tam olarak `origin <ref>` bekleniyor");
    if (a[0] !== "origin") return deny("uzak yalnız origin");
    const m = /^vlad\/(T\d{8}-\d+)$/.exec(a[1]!);
    if (!m) return deny("ref biçimi geçersiz (+, :, başka dal, bayrak yok)");
    if (ownId !== null && m[1] !== ownId) return deny("yalnız kendi vlad/<id> dalı");
  }
  return null;
}
