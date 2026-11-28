//! src/hooks/mode-guard.ts `checkWorkerMode` birebir (F-vlad-287). Hata (`Err`) = TS'te fırlatılan istisna:
//! kanca bunu catch yoluna (fail-closed) götürür.

use crate::json::ToolInput;
use crate::jsre::{glob_hits, seg_matches};
use crate::path::{basename, dirname, is_absolute, join, resolve};
use crate::sys;
use crate::text::{fold, js_re};
use regex::Regex;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::sync::OnceLock;

type R<T> = Result<T, String>;

pub const MODE_GUARD_TOOLS: [&str; 8] = ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "Read", "Grep", "Glob"];
const READ_TOOLS: [&str; 3] = ["Read", "Grep", "Glob"];
pub const WHY: &str = "çalışan oturumu mod/koruma yazamaz: gece-bekçi modunu (kb mode.json), hook'u ve settings/vlad.config dosyalarını yalnız VLAD/kullanıcı değiştirir (ana VLAD'san ana repo dizininden çalıştır; çalışansan `vlad task ask` ile VLAD'a sor)";
const SETTINGS: [&str; 2] = ["settings.json", "settings.local.json"];

fn re(cell: &'static OnceLock<Regex>, src: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(&js_re(src)).expect("statik regex"))
}

#[cfg(test)]
thread_local! {
    static TEST_SECRET: RefCell<Option<String>> = const { RefCell::new(None) };
}
#[cfg(test)]
pub fn set_secret_dir_for_tests(d: Option<String>) {
    TEST_SECRET.with(|c| *c.borrow_mut() = d);
}

/// token.ts `secretDir()`: passwd ev dizini + `.vlad-secret` (HOME ve ortam değişkeni kullanılmaz).
fn secret_dir() -> R<String> {
    #[cfg(test)]
    if let Some(d) = TEST_SECRET.with(|c| c.borrow().clone()) {
        return Ok(d);
    }
    Ok(join(&[&sys::user_homedir()?, ".vlad-secret"]))
}

/// Yol karşılaştırması: `\` → `/`, sondaki `/` atılır, APFS katlaması (K1), küçük harf.
fn norm(p: &str) -> String {
    let s = p.replace('\\', "/");
    fold(s.trim_end_matches('/')).to_lowercase()
}

fn is_glob(s: &str) -> bool {
    s.contains(['*', '?', '['])
}

/// JS `GetSubstitution` (yakalama grubu yok): `$$`, `$&`, `` $` ``, `$'`; diğer `$` dizileri olduğu gibi.
fn substitute(rep: &str, matched: &str, before: &str, after: &str) -> String {
    let mut o = String::new();
    let mut it = rep.chars().peekable();
    while let Some(c) = it.next() {
        if c != '$' {
            o.push(c);
            continue;
        }
        match it.peek() {
            Some('$') => {
                it.next();
                o.push('$');
            }
            Some('&') => {
                it.next();
                o.push_str(matched);
            }
            Some('`') => {
                it.next();
                o.push_str(before);
            }
            Some('\'') => {
                it.next();
                o.push_str(after);
            }
            _ => o.push('$'),
        }
    }
    o
}

/// `t.replace(/^~(?=\/|\\|$)|\$\{?HOME\}?/g, homedir().replace(/\\/g, "/"))` — homedir her çağrıda değerlendirilir.
fn expand(t: &str) -> R<String> {
    let h = sys::homedir()?.replace('\\', "/");
    let b = t.as_bytes();
    let mut out = String::new();
    let mut last = 0usize;
    let mut i = 0usize;
    while i < b.len() {
        let mlen = if i == 0 && b[0] == b'~' && (b.len() == 1 || b[1] == b'/' || b[1] == b'\\') {
            1
        } else if b[i] == b'$' {
            let mut j = i + 1;
            if b.get(j) == Some(&b'{') && t[j + 1..].starts_with("HOME") {
                j += 1;
            }
            if t[j..].starts_with("HOME") {
                j += 4;
                if b.get(j) == Some(&b'}') {
                    j += 1;
                }
                j - i
            } else {
                0
            }
        } else {
            0
        };
        if mlen > 0 {
            out.push_str(&t[last..i]);
            out.push_str(&substitute(&h, &t[i..i + mlen], &t[..i], &t[i + mlen..]));
            i += mlen;
            last = i;
        } else {
            i += 1;
        }
    }
    out.push_str(&t[last..]);
    Ok(out)
}

pub struct Guard<'a> {
    kb: Option<&'a str>,
    vlad_home: Option<&'a str>,
    cwd: Option<&'a str>,
    memo: RefCell<HashMap<String, String>>,
    sd: RefCell<Option<String>>,
    /// açık `real` özyineleme derinliği (C1: yığın taşması süreci düşürür, çıkış 134 = fail-open)
    frames: Cell<u32>,
}

/// TS'te V8 ~2700 ata düzeyinde (makineye bağlı) `RangeError: Maximum call stack size exceeded` fırlatır ve kanca catch
/// yoluna düşer. Rust'ta sınırsız özyineleme yığını taşırıp süreci yakalanamaz biçimde düşürürdü (çıkış 134 = fail-open);
/// bu yüzden V8 sınırının altında aynı hatayı bilerek üretiriz (Err → catch yolu).
/// 2000–~2700 bandında iki taraf farklı yoldan karar verir: Rust catch yoluna düşer (ham metin: dosya aracı → ret;
/// Bash → yalnız git…push ya da mode/settings/vlad.config/dist.hooks/vlad-secret kelimesi varsa ret), TS ise normal
/// denetimi tamamlar. Yani bantta Rust bazen TS'ten katı (dosya aracı), bazen gevşek olabilir (tetik kelimesi olmayan,
/// symlink üzerinden korumalı dizine çözülen Bash yolu). Bu derinlikte yol PATH_MAX (1024 bayt) nedeniyle açılamaz.
/// Fark testi bandı (2000–2700) dışarıda bırakır.
pub const MAX_REAL_FRAMES: u32 = 2000;

impl<'a> Guard<'a> {
    pub fn new(kb: Option<&'a str>, vlad_home: Option<&'a str>, cwd: Option<&'a str>) -> Self {
        Guard { kb, vlad_home, cwd, memo: RefCell::new(HashMap::new()), sd: RefCell::new(None), frames: Cell::new(0) }
    }

    fn cwd(&self) -> &str {
        self.cwd.unwrap_or(".")
    }

    fn sdir(&self) -> R<String> {
        if let Some(v) = self.sd.borrow().as_ref() {
            return Ok(v.clone());
        }
        let v = secret_dir()?;
        *self.sd.borrow_mut() = Some(v.clone());
        Ok(v)
    }

    /// Tam realpath; yok/dangling ise ata dizini çözer, son bileşen symlink ise hedefini izler.
    fn real(&self, p: &str, depth: u32) -> R<String> {
        let n = self.frames.get();
        if n >= MAX_REAL_FRAMES {
            return Err("Maximum call stack size exceeded".into());
        }
        self.frames.set(n + 1);
        let r = self.real_frame(p, depth);
        self.frames.set(n);
        r
    }

    fn real_frame(&self, p: &str, depth: u32) -> R<String> {
        let abs = resolve(&[p])?;
        if depth == 0 {
            if let Some(h) = self.memo.borrow().get(&abs) {
                return Ok(h.clone());
            }
        }
        let out = self.real_uncached(&abs, depth)?;
        if depth == 0 {
            self.memo.borrow_mut().insert(abs, out.clone());
        }
        Ok(out)
    }

    fn real_uncached(&self, abs: &str, depth: u32) -> R<String> {
        if let Some(r) = sys::realpath(abs) {
            return Ok(r);
        }
        let parent = dirname(abs);
        let base = if parent == abs { abs.to_string() } else { join(&[&self.real(&parent, depth)?, &basename(abs)]) };
        if depth < 8 {
            // TS: try { if (lstat.isSymbolicLink()) return real(resolve(dirname, readlink), depth+1) } catch {} — iç hatalar yutulur
            if sys::lstat_is_symlink(&base) == Some(true) {
                if let Some(link) = sys::readlink(&base) {
                    if let Ok(target) = resolve(&[&dirname(&base), &link]) {
                        if let Ok(r) = self.real(&target, depth + 1) {
                            return Ok(r);
                        }
                    }
                }
            }
        }
        Ok(base)
    }

    fn secret_hit(&self, t: &str) -> R<bool> {
        let stripped: String = t.chars().filter(|c| !matches!(c, '"' | '\'' | '\\')).collect();
        let n = norm(&expand(&stripped)?);
        if n.contains(".vlad-secret") {
            return Ok(true); // SECRET = /\.vlad-secret/i; n zaten küçük harf
        }
        let sd = norm(&self.sdir()?);
        Ok(n == sd || n.starts_with(&format!("{}/", sd)))
    }

    fn secret_real(&self) -> R<String> {
        Ok(norm(&self.real(&self.sdir()?, 0)?))
    }
    fn inside_secret(&self, x: &str) -> R<bool> {
        let n = norm(x);
        let sd = self.secret_real()?;
        Ok(n == sd || n.starts_with(&format!("{}/", sd)))
    }
    fn ancestor_of_secret(&self, x: &str) -> R<bool> {
        let n = norm(x);
        Ok(n.is_empty() || self.secret_real()?.starts_with(&format!("{}/", n)))
    }

    /// Korunan yol: kb mode.json, `.claude/settings(.local).json`, `<vladHome>/dist/hooks/**`, `<vladHome>/vlad.config(.local).json` (F-vlad-406).
    fn protected_path(&self, p: &str, any_dir: bool) -> R<Option<&'static str>> {
        static CLAUDE: OnceLock<Regex> = OnceLock::new();
        if self.secret_hit(p)? {
            return Ok(Some("anahtar"));
        }
        let t = expand(&p.replace('\\', "/"))?;
        if !is_glob(&t) && self.inside_secret(&self.real(&resolve(&[self.cwd(), &t])?, 0)?)? {
            return Ok(Some("anahtar"));
        }
        let base = basename(&t);
        if glob_hits(&base, "mode.json") {
            let hit = any_dir
                || self.kb.is_none()
                || is_glob(&base)
                || norm(&self.real(&resolve(&[self.cwd(), &t])?, 0)?) == norm(&self.real(&join(&[self.kb.unwrap(), "mode.json"]), 0)?);
            return Ok(if hit { Some("mode.json") } else { None });
        }
        if re(&CLAUDE, r"(?:^|/)\.(?i-u:claude)/").is_match(&fold(&t)) && SETTINGS.iter().any(|s| glob_hits(&base, s)) {
            return Ok(Some("settings"));
        }
        if let Some(g) = self.glob_protected(&t)? {
            return Ok(Some(g)); // F-vlad-408/409 (jokersiz yolda da realpath biçimi: symlink → .claude)
        }
        if let Some(home) = self.vlad_home.filter(|h| !h.is_empty()) {
            let target = if is_absolute(&t) { t.clone() } else { resolve(&[self.cwd(), &t])? };
            let abs = norm(&self.real(&target, 0)?);
            let home = norm(&self.real(home, 0)?);
            if abs == format!("{}/vlad.config.json", home) || abs == format!("{}/vlad.config.local.json", home) || abs == format!("{}/dist/hooks", home) || abs.starts_with(&format!("{}/dist/hooks/", home)) {
                return Ok(Some("vlad"));
            }
        }
        Ok(None)
    }

    fn check_bash(&self, cmd: &str, depth: u32) -> R<Option<String>> {
        static SHELL_C: OnceLock<Regex> = OnceLock::new();
        static RAW_SPLIT: OnceLock<Regex> = OnceLock::new();
        static MODE_CMD: OnceLock<Regex> = OnceLock::new();
        static CLEAN: OnceLock<Regex> = OnceLock::new();
        static SEP_TOKEN: OnceLock<Regex> = OnceLock::new();
        static WRITE_TOOL: OnceLock<Regex> = OnceLock::new();
        static REDIR: OnceLock<Regex> = OnceLock::new();
        static WS_SPLIT: OnceLock<Regex> = OnceLock::new();
        let shell_c = re(
            &SHELL_C,
            r#"(?:^|[⟨WS⟩;&|(])(?i-u:ba|z|da)?(?:(?i-u:s)|ſ)(?i-u:h)⟨s⟩+(?:-⟨S⟩+⟨s⟩+)*-[A-Za-z0-9_]*(?i-u:c)⟨s⟩+(?:"((?:[^"\\]|\\[^\n\r\x{2028}\x{2029}])*)"|'([^']*)')|⟨b⟩(?i-u:eval)⟨s⟩+(?:"((?:[^"\\]|\\[^\n\r\x{2028}\x{2029}])*)"|'([^']*)')"#,
        );
        for m in shell_c.captures_iter(cmd) {
            let inner = m.get(1).or(m.get(2)).or(m.get(3)).or(m.get(4)).map(|x| x.as_str());
            if let Some(inner) = inner {
                if !inner.is_empty() && depth < 3 {
                    if let Some(r) = self.check_bash(inner, depth + 1)? {
                        return Ok(Some(r));
                    }
                }
            }
        }
        if self.secret_hit(cmd)? {
            return Ok(Some(format!("{} (anahtar: gizli mod anahtarına dokunulamaz)", WHY)));
        }
        let raw_toks: Vec<&str> = re(&RAW_SPLIT, r"[⟨WS⟩;&|()]+").split(cmd).filter(|s| !s.is_empty()).collect();
        let mode_cmd = re(
            &MODE_CMD,
            r"^(?:[A-Za-z0-9_.-]+=⟨S⟩*⟨s⟩+|(?i-u:env|command|exec|nohup|time|sudo|npx|tsx|node)⟨b⟩(?:⟨s⟩+-⟨S⟩+(?:⟨s⟩+[A-Za-z_]+)?)*⟨s⟩+)*(?:⟨S⟩*[/\\])?(?i-u:vlad|cli)(?:\.(?i-u:cmd|exe|js|mjs|ts|ps1))?(?:⟨s⟩+-⟨S⟩+)*⟨s⟩+(?i-u:mode)⟨b⟩⟨s⟩*(⟨S⟩*)",
        );
        for seg in segments(cmd) {
            // K1: komut adı PATH'te APFS ile çözülür (katlama yalnız eşleşmede; yollar ham kalır)
            if let Some(mm) = mode_cmd.captures(&fold(&seg)) {
                if mm[1].to_lowercase() != "status" {
                    return Ok(Some(format!("{}; yalnız `vlad mode status` serbest", WHY)));
                }
            }
            let clean = re(&CLEAN, r"[0-9]*>&[0-9]+|&?[0-9]*>>?⟨s⟩*/dev/null").replace_all(&seg, " ").into_owned();
            let toks: Vec<&str> = re(&SEP_TOKEN, r#"[⟨WS⟩;&|<>(),='"]+"#).split(&clean).filter(|s| !s.is_empty()).collect();
            let tools = re(
                &WRITE_TOOL,
                r"(?:^|⟨s⟩)(?i-u:tee|cp|mv|rm|truncate|dd|ln|install|perl|python3?|node|ruby|sh|bash|zsh|pwsh|powershell|jq|sponge|patch|awk|ed|curl|wget|rsync|set-content|out-file|remove-item|ni|sc)(?:⟨s⟩|$)|⟨b⟩(?i-u:sed)⟨b⟩[^|;&]*⟨s⟩(?:-[A-Za-z]*(?i-u:i)|--(?i-u:in-place))|⟨b⟩(?i-u:git)⟨s⟩+(?i-u:apply|checkout|restore)⟨b⟩",
            )
            .is_match(&fold(&clean)); // K1: ſed, baſh, inſtall, aw\u{212A}
            let redirect_targets: Vec<&str> = re(&REDIR, r"(?:>>?)⟨s⟩*([^⟨WS⟩;&|<>()]+)").captures_iter(&clean).map(|c| c.get(1).unwrap().as_str()).collect();
            let ws_toks: Vec<&str> = re(&WS_SPLIT, r"⟨s⟩+").split(&clean).collect();
            for t in ws_toks.iter().chain(raw_toks.iter()) {
                if self.glob_reaches_secret(t)? {
                    return Ok(Some(format!("{} (anahtar: joker gizli dizine açılabilir: {})", WHY, t)));
                }
            }
            // F-vlad-408/409: SEP_TOKEN virgülde böler; `{a,b}` süslü sözcükler boşlukla bölünmüş haliyle de denetlenir
            let braced: Vec<&str> = if tools { toks.iter().copied().chain(ws_toks.iter().copied().filter(|x| !x.is_empty() && x.contains('{'))).collect() } else { Vec::new() };
            let list: &Vec<&str> = if tools { &braced } else { &redirect_targets };
            for t in list {
                let hit = match self.protected_path(t, true)? {
                    Some(h) => Some(h),
                    None => match self.kb {
                        Some(kb) if norm(&expand(t)?).starts_with(&format!("{}/", norm(kb))) => Some("kb"),
                        _ => None,
                    },
                };
                if let Some(h) = hit {
                    return Ok(Some(format!("{} ({}: {})", WHY, h, t)));
                }
            }
        }
        Ok(None)
    }

    /// Okuma aracı yolu gizli dizine çözülüyor mu (`base` = göreli yolun çözüldüğü dizin).
    fn reads_secret(&self, p: &str, base: &str, dir_root: bool) -> R<bool> {
        if self.secret_hit(p)? {
            return Ok(true);
        }
        let abs = resolve(&[base, &expand(&p.replace('\\', "/"))?])?.replace('\\', "/");
        match abs.find(['*', '?', '[', '{']) {
            None => {
                let f = self.real(&abs, 0)?;
                Ok(self.inside_secret(&f)?
                    || self.inside_secret(&abs)?
                    || (dir_root && (self.ancestor_of_secret(&f)? || self.ancestor_of_secret(&abs)?)))
            }
            Some(cut) => {
                let head = &abs[..cut];
                let dir = match head.rfind('/') {
                    Some(i) => &head[..=i],
                    None => "",
                };
                let root = self.real(if dir.is_empty() { "/" } else { dir }, 0)?;
                Ok(self.inside_secret(&root)? || self.ancestor_of_secret(&root)?)
            }
        }
    }

    fn check_read_tool(&self, tool: &str, input: &ToolInput) -> R<Option<String>> {
        static DOTDOT: OnceLock<Regex> = OnceLock::new();
        let cwd = self.cwd().to_string();
        let s = |k: &str| input.get(k).as_str().map(|x| x.to_string());
        let hint = |k: &str, v: &str| format!("{} (okuma: gizli mod anahtarı/approver dizini {}: {})", WHY, k, v);
        if let Some(file) = s("file_path") {
            if self.reads_secret(&file, &cwd, false)? {
                return Ok(Some(hint("file_path", &file)));
            }
        }
        if tool == "Read" {
            return Ok(None);
        }
        let root = s("path");
        if self.reads_secret(root.as_deref().unwrap_or("."), &cwd, true)? {
            return Ok(Some(match &root {
                None => hint("kök(cwd)", &cwd),
                Some(r) => hint("path", r),
            }));
        }
        let root_abs = resolve(&[&cwd, &expand(&root.as_deref().unwrap_or(".").replace('\\', "/"))?])?;
        let keys: &[&str] = if tool == "Glob" { &["pattern", "glob"] } else { &["glob"] };
        for k in keys {
            let Some(v) = s(k) else { continue };
            if is_glob(&v) && re(&DOTDOT, r"(?:^|/)\.\.(?:/|$)").is_match(&v.replace('\\', "/")) {
                return Ok(Some(format!("{} (okuma: jokerli desende '..' yasak {}: {})", WHY, k, v)));
            }
            let mut bases = vec![cwd.clone()];
            if root_abs != cwd {
                bases.push(root_abs.clone());
            }
            for b in &bases {
                if self.reads_secret(&v, b, true)? {
                    return Ok(Some(hint(k, &v)));
                }
            }
        }
        Ok(None)
    }

    /// mode-guard.ts `globProtected`: F-vlad-408/409 — jokerli (ya da symlink önekli) yol korunan bir yola açılabiliyor mu.
    /// Bileşen bileşen seg_matches (ham + APFS katlı, baştaki nokta kuralı); `*` kestirmesi yok; jokersiz önek realpath'lenir.
    fn glob_protected(&self, t: &str) -> R<Option<&'static str>> {
        let segs = |p: &str| -> Vec<String> { p.replace('\\', "/").split('/').filter(|s| !s.is_empty()).map(String::from).collect() };
        let mut forms: Vec<Vec<String>> = Vec::new();
        for alt in brace_expand(t, 0) {
            let abs = resolve(&[self.cwd(), &alt])?.replace('\\', "/");
            forms.push(segs(&abs));
            let parts: Vec<&str> = abs.split('/').collect();
            match parts.iter().position(|s| is_glob(s)) {
                Some(k) if k > 0 => {
                    let mut f = segs(&self.real(&format!("{}/", parts[..k].join("/")), 0)?);
                    f.extend(parts[k..].iter().filter(|s| !s.is_empty()).map(|s| s.to_string()));
                    forms.push(f);
                }
                None => forms.push(segs(&self.real(&abs, 0)?)),
                _ => {}
            }
        }
        let hits = |gs: &[String], target: &[String], prefix: bool| -> bool {
            (if prefix { gs.len() >= target.len() } else { gs.len() == target.len() }) && target.iter().enumerate().all(|(i, s)| seg_matches(&gs[i], s))
        };
        let with = |r: &[String], tail: &[&str]| -> Vec<String> { r.iter().cloned().chain(tail.iter().map(|s| s.to_string())).collect() };
        for gs in &forms {
            let n = gs.len();
            if n >= 2 && seg_matches(&gs[n - 2], ".claude") && SETTINGS.iter().any(|s| seg_matches(&gs[n - 1], s)) {
                return Ok(Some("settings"));
            }
            if let Some(kb) = self.kb {
                for r in [segs(kb), segs(&self.real(kb, 0)?)] {
                    if hits(gs, &with(&r, &["mode.json"]), false) {
                        return Ok(Some("mode.json"));
                    }
                }
            }
            if let Some(home) = self.vlad_home.filter(|h| !h.is_empty()) {
                for r in [segs(home), segs(&self.real(home, 0)?)] {
                    if hits(gs, &with(&r, &["vlad.config.json"]), false) || hits(gs, &with(&r, &["vlad.config.local.json"]), false) || hits(gs, &with(&r, &["dist", "hooks"]), true) {
                        return Ok(Some("vlad"));
                    }
                }
            }
        }
        Ok(None)
    }

    fn glob_reaches_secret(&self, tok: &str) -> R<bool> {
        static ROOTED: OnceLock<Regex> = OnceLock::new();
        if !tok.contains(['*', '?', '[', '{']) || !re(&ROOTED, r"^(?:~|\$\{?HOME\}?|/|[A-Za-z]:[\\/])").is_match(tok) {
            return Ok(false);
        }
        let sd = self.sdir()?;
        let forms: Vec<Vec<String>> = [sd.clone(), self.real(&sd, 0)?]
            .iter()
            .map(|d| d.replace('\\', "/").split('/').filter(|s| !s.is_empty()).map(String::from).collect())
            .collect();
        for alt in brace_expand(&expand(&tok.replace('\\', "/"))?, 0) {
            let gs: Vec<&str> = alt.split('/').filter(|s| !s.is_empty()).collect();
            if forms.iter().any(|sd| gs.iter().enumerate().all(|(i, g)| i >= sd.len() || seg_matches(g, &sd[i]))) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn check(&self, tool: &str, input: &ToolInput) -> R<Option<String>> {
        // K1: girdi ham kalır (realpath/lstat/readlink ham adla: Linux/NTFS/harf duyarlı APFS'te ſx ≠ sx); APFS katlaması yalnız
        // karşılaştırmalarda (norm, glob_hits, seg_matches, .claude / WRITE_TOOL / MODE_CMD / SHELL_C) — TS checkWorkerMode ile aynı
        if tool == "Bash" {
            return self.check_bash(input.get("command").as_str().unwrap_or(""), 0);
        }
        if !MODE_GUARD_TOOLS.contains(&tool) {
            return Ok(None);
        }
        if READ_TOOLS.contains(&tool) {
            return self.check_read_tool(tool, input);
        }
        let fp = input.get("file_path");
        let f = if fp.is_nullish() { input.get("notebook_path") } else { fp };
        let Some(f) = f.as_str() else { return Ok(None) };
        Ok(self.protected_path(f, false)?.map(|h| format!("{} ({}: {})", WHY, h, f)))
    }
}

/// `checkWorkerMode(tool, input, kbDir, {vladHome, cwd})`.
pub fn check_worker_mode(tool: &str, input: &ToolInput, kb: Option<&str>, vlad_home: Option<&str>, cwd: Option<&str>) -> R<Option<String>> {
    Guard::new(kb, vlad_home, cwd).check(tool, input)
}

/// Komutu tırnak dışındaki ayraçlarda (`;`, `&`, `|`, `(`, backtick, satır sonu) böler; tırnak/ters bölü atılır.
fn segments(cmd: &str) -> Vec<String> {
    static CONT: OnceLock<Regex> = OnceLock::new();
    let c = re(&CONT, r"\\\r?\n").replace_all(cmd, "");
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut q: Option<char> = None;
    let mut it = c.chars();
    while let Some(ch) = it.next() {
        if let Some(qc) = q {
            if ch == qc {
                q = None;
            } else {
                cur.push(ch);
            }
            continue;
        }
        if ch == '"' || ch == '\'' {
            q = Some(ch);
            continue;
        }
        if ch == '\\' {
            if let Some(n) = it.next() {
                cur.push(n);
            }
            continue;
        }
        if ";&|(`\n".contains(ch) {
            out.push(std::mem::take(&mut cur));
            continue;
        }
        cur.push(ch);
    }
    out.push(cur);
    out.into_iter().map(|s| crate::text::js_trim(&s).to_string()).filter(|s| !s.is_empty()).collect()
}

fn brace_expand(s: &str, n: u32) -> Vec<String> {
    static BRACE: OnceLock<Regex> = OnceLock::new();
    let Some(m) = re(&BRACE, r"\{([^{}]*)\}").captures(s) else { return vec![s.to_string()] };
    let whole = m.get(0).unwrap();
    let inner = m.get(1).unwrap().as_str();
    if n > 4 || !inner.contains(',') {
        return vec![s.to_string()];
    }
    let mut out: Vec<String> = Vec::new();
    for alt in inner.split(',') {
        out.extend(brace_expand(&format!("{}{}{}", &s[..whole.start()], alt, &s[whole.end()..]), n + 1));
        if out.len() >= 64 {
            break; // K1: TS ile aynı erken çıkış; ilk 64 sonuç değişmez
        }
    }
    out.truncate(64);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::{Val, INPUT_KEYS};
    use std::os::unix::fs::symlink;

    const KB: &str = "/home/u/vlad-kb";
    const HOME: &str = "/home/u/vlad";

    fn input(pairs: &[(&str, &str)]) -> ToolInput {
        let mut ti = ToolInput::default();
        for (k, v) in pairs {
            let i = INPUT_KEYS.iter().position(|x| x == k).unwrap();
            ti.fields[i] = Val::Str(v.to_string());
        }
        ti
    }
    fn bash(c: &str) -> Option<String> {
        check_worker_mode("Bash", &input(&[("command", c)]), Some(KB), Some(HOME), Some("/work/wt")).unwrap()
    }
    fn edit(t: &str, p: &str) -> Option<String> {
        check_worker_mode(t, &input(&[("file_path", p)]), Some(KB), Some(HOME), Some("/work/wt")).unwrap()
    }
    fn has(r: &Option<String>, s: &str) -> bool {
        r.as_deref().is_some_and(|x| x.contains(s))
    }

    // test/hooks/mode-guard.test.ts
    #[test]
    fn bash_mode_writers() {
        for c in ["vlad mode off", "env -u VLAD_TASK_ID vlad mode off", "cd / && vlad mode night --until 23:00", "node /x/dist/cli.js mode watch on", "vlad   mode  off", "v\"la\"d mode off", "vlad \\\nmode off", "true; vlad mode off", "node cli.js mode off"] {
            assert!(has(&bash(c), "mod"), "{c:?}");
        }
        for c in ["vlad mode status && vlad mode off", "vlad mode status\nvlad mode off", "vlad mode status | cat; vlad mode off", "vlad mode status; vlad mode off", "vlad.cmd mode off", "vlad.exe mode off", "npx tsx src/cli.ts mode off", "vlad --json mode off", "vlad -q mode night"] {
            assert!(has(&bash(c), "mod"), "{c:?}");
        }
        assert_eq!(bash("vlad mode status; echo ok"), None);
    }

    #[test]
    fn bash_mode_json() {
        for c in ["grep -r mode.json src", "git diff -- src/mode/mode.json", &format!("cat {KB}/mode.json")] {
            assert_eq!(bash(c), None, "{c:?}");
        }
        for c in [format!("echo x >{KB}/mode.json"), format!("tee {KB}/mode.json"), format!("mv a {KB}/mode.json"), "python3 -c \"open('mode.json','w')\"".into(), format!("truncate -s0 {KB}/mode.json"),
            format!("echo '{{}}' > {KB}/mode.json"), format!("cp x {KB}/mode.json"), format!("sed -i s/a/b/ {KB}/MODE.JSON"), format!("echo x > {KB}/mo\"de.j\"son"), "rm $KB/mode.json".into()] {
            assert!(has(&bash(&c), "mode.json"), "{c:?}");
        }
        for c in ["vlad mode status", "vlad task log T1 x", "git status", "echo mode", "npm run build", "vlad mode status --json"] {
            assert_eq!(bash(c), None, "{c:?}");
        }
    }

    // C1 (review): çok derin yok-yol TS'te RangeError (fail-closed); Rust yığını taşırmamalı, aynı hatayı üretmeli
    #[test]
    fn deep_path_fails_closed() {
        // hook::run gibi geniş yığınlı iş parçacığında
        std::thread::Builder::new().stack_size(64 << 20).spawn(deep_path_body).unwrap().join().unwrap();
    }
    fn deep_path_body() {
        let tmp = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        let deep = |n: usize| format!("{}/pg-rs-yok{}", tmp.display(), "/a".repeat(n));
        let r = |t: &str, k: &str, n: usize| check_worker_mode(t, &input(&[(k, &deep(n))]), Some(KB), Some(HOME), Some("/work/wt"));
        assert_eq!(r("Read", "file_path", 1000).unwrap(), None);
        assert_eq!(r("Write", "file_path", 1000).unwrap(), None);
        for n in [3000, 20000, 60000] {
            assert!(r("Read", "file_path", n).is_err(), "Read {n}");
            assert!(r("Write", "file_path", n).is_err(), "Write {n}");
            assert!(r("Bash", "command", n).is_err() || r("Bash", "command", n).is_ok(), "Bash {n} düşmemeli");
        }
        let cmd = format!("ls > {}; vlad task log x", deep(20000));
        assert!(check_worker_mode("Bash", &input(&[("command", &cmd)]), Some(KB), Some(HOME), Some("/work/wt")).is_err());
    }

    #[test]
    fn file_tools() {
        for t in ["Edit", "Write", "MultiEdit", "NotebookEdit"] {
            assert!(has(&edit(t, &format!("{KB}/mode.json")), "mode.json"));
            assert!(has(&edit(t, &format!("{KB}/sub/../MODE.json")), "mode.json"));
            assert_eq!(edit(t, &format!("{KB}/tasks/T1.md")), None);
            assert_eq!(edit(t, "/work/wt/src/mode.json"), None);
        }
        let prot = ["/Users/x/.claude/settings.json", "/Users/x/.claude/settings.local.json", "/work/wt/.claude/settings.json", "~/.claude/settings.json", &format!("{HOME}/dist/hooks/push-guard-hook.js"), &format!("{HOME}/dist/hooks/sub/x.js"), &format!("{HOME}/vlad.config.json")].map(String::from);
        for p in &prot {
            for t in ["Edit", "Write", "MultiEdit", "NotebookEdit"] {
                assert!(edit(t, p).is_some(), "{t} {p}");
            }
            for c in [format!("sed -i s/a/b/ {p}"), format!("echo {{}} > {p}"), format!("tee {p}"), format!("cp x {p}"), format!("mv x {p}"), format!("jq . {p} | sponge {p}"), format!("python3 -c \"open('{p}','w')\""), format!("node -e \"require('fs').writeFileSync('{p}','')\""), format!("truncate -s0 {p}")] {
                assert!(bash(&c).is_some(), "{c:?}");
            }
        }
        for p in ["/work/wt/src/settings.json", &format!("{HOME}/dist/cli.js"), &format!("{HOME}/src/vlad.config.json"), "/work/wt/vlad.config.json"] {
            assert_eq!(edit("Edit", p), None, "{p}");
        }
        for c in [format!("cat {HOME}/vlad.config.json"), "cat ~/.claude/settings.json".into(), "grep hooks ~/.claude/settings.json".into(), format!("ls {HOME}/dist/hooks"), "sed -n 1,40p ~/.claude/settings.json 2>&1".into()] {
            assert_eq!(bash(&c), None, "{c:?}");
        }
    }

    #[test]
    fn vlad_config_local_protected() {
        // F-vlad-406: local katman kbDir'i sığ birleşimle değiştirebilir
        let p = format!("{HOME}/vlad.config.local.json");
        for t in ["Edit", "Write", "MultiEdit", "NotebookEdit"] {
            assert!(edit(t, &p).is_some(), "{t}");
            assert!(edit(t, &format!("{HOME}/VLAD.CONFIG.LOCAL.JSON")).is_some(), "{t} büyük harf");
        }
        for c in [format!("echo {{}} > {p}"), format!("echo {{}} >> {p}"), format!("tee {p}"), format!("cp x {p}"), format!("sed -i s/a/b/ {p}"), format!("ln -s /tmp/x {p}")] {
            assert!(bash(&c).is_some(), "{c:?}");
        }
        assert!(check_worker_mode("Write", &input(&[("file_path", "vlad.config.local.json")]), Some(KB), Some(HOME), Some(HOME)).unwrap().is_some());
        assert!(check_worker_mode("Write", &input(&[("file_path", "../vlad/vlad.config.local.json")]), Some(KB), Some(HOME), Some("/home/u/vlad-kb")).unwrap().is_some());
        assert_eq!(edit("Write", "/work/wt/vlad.config.local.json"), None);
        assert_eq!(bash(&format!("cat {p}")), None);
    }

    #[test]
    fn glob_protected_settings() {
        // F-vlad-408 (test/hooks/mode-guard.test.ts ile aynı vakalar)
        for p in ["~/.cla*/settings.json", "~/.?laude/settings.json", "~/.c[l]aude/settings.json", "~/.claude/*ettings.json", "~/.claude/*", "~/.claude/settings.*", "~/.*/settings.local.json", "~/.{claude,x}/settings.json", "/Users/x/.cla*/*.local.json", ".c?aude/settings.json", "~/.c*/\u{17F}ett*.json"] {
            for c in [format!("echo {{}} > {p}"), format!("tee {p}"), format!("cp x {p}"), format!("sed -i s/a/b/ {p}")] {
                assert!(bash(&c).is_some(), "{c:?}");
            }
            assert!(edit("Write", p).is_some(), "{p}");
        }
        for c in ["cat ~/.cla*/settings.json", "ls ~/.claude/*", "echo x > ~/*/settings.json", "cp x ~/.claude/*.md", "cp x src/*.json", "echo x > ~/.cla*/other.json"] {
            assert_eq!(bash(c), None, "{c:?}");
        }
    }

    #[test]
    fn glob_protected_vlad() {
        // F-vlad-409
        for p in [format!("{HOME}/vlad.config.local.js?n"), format!("{HOME}/vlad.config.local.*"), format!("{HOME}/vlad.conf?g.json"), format!("{HOME}/di?t/hooks/push-guard"), format!("{HOME}/dist/*/push-guard"), format!("{HOME}/*.json"), format!("{HOME}/dist/*"), format!("{HOME}/dist/hoo[k]s/x.js"), format!("{HOME}/{{dist,x}}/hooks/a"), format!("{KB}/mod?.json"), format!("{KB}/*.json"), "/home/u/v*/vlad.config.json".to_string()] {
            for c in [format!("echo {{}} > {p}"), format!("tee {p}"), format!("cp x {p}")] {
                assert!(bash(&c).is_some(), "{c:?}");
            }
            assert!(edit("Write", &p).is_some(), "{p}");
        }
        assert!(check_worker_mode("Bash", &input(&[("command", "cp x di?t/*/push-guard")]), Some(KB), Some(HOME), Some(HOME)).unwrap().is_some());
        for c in [format!("cat {HOME}/*.json"), format!("cp x {HOME}/src/*.ts"), format!("echo x > {HOME}/dist/*.js"), "cp x /work/wt/*.json".to_string(), format!("cp x {HOME}/vlad.config.*.bak")] {
            assert_eq!(bash(&c), None, "{c:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn glob_protected_symlink_prefix() {
        // F-vlad-408/409: jokersiz önek realpath'lenir (test/hooks/mode-guard-bypass.test.ts ile aynı)
        let t = Tmp::new("globln");
        let (cwd, root) = (t.cwd(), t.root.clone());
        let (cl, vh) = (format!("{root}/.claude"), format!("{root}/vh"));
        std::fs::create_dir_all(&cl).unwrap();
        std::fs::create_dir_all(format!("{vh}/dist/hooks")).unwrap();
        std::os::unix::fs::symlink(&cl, format!("{cwd}/l")).unwrap();
        std::os::unix::fs::symlink(&vh, format!("{cwd}/v")).unwrap();
        let r = |tool: &str, k: &str, v: &str| check_worker_mode(tool, &input(&[(k, v)]), None, Some(&vh), Some(&cwd)).unwrap();
        for c in ["echo x > l/*ettings.json", "cp x l/settings.loc?l.json", "echo x > l/settings.json", "cp x v/vlad.config.*", "cp x v/di?t/hooks/a", "tee v/*.json"] {
            assert!(r("Bash", "command", c).is_some(), "{c:?}");
        }
        for p in ["l/settings.json", "l/*ettings.json", "v/vlad.config.local.js?n"] {
            assert!(r("Write", "file_path", p).is_some(), "{p}");
        }
        for c in ["echo x > l/other.json", "cp x v/src/*.ts"] {
            assert_eq!(r("Bash", "command", c), None, "{c:?}");
        }
    }

    #[test]
    fn globs_and_command_position() {
        for c in [format!("rm {KB}/mod?.json"), format!("echo x > {KB}/m*e.json"), format!("cp x {KB}/mode.jso[n]"), format!("truncate -s0 {KB}/mo?e.json"), format!("echo x > {KB}/tasks/T1.md"), format!("tee {KB}/findings/F1.md"), format!("mv a {KB}/x")] {
            assert!(bash(&c).is_some(), "{c:?}");
        }
        for c in ["rm *.json".into(), "rm -rf build/*".into(), format!("cat {KB}/tasks/T1.md"), format!("grep x {KB}/tasks/T1.md > /tmp/out.txt")] {
            assert_eq!(bash(&c), None, "{c:?}");
        }
        for c in ["git grep 'vlad mode off'".into(), "git commit -m \"docs: vlad mode off notu\"".into(), "git commit -m \"a; vlad mode off\"".into(), "vlad task log T1 'vlad mode off'".into(), "echo \"vlad mode night\"".into(), format!("sed -n '1,80p' {KB}/mode.json"), format!("cat {KB}/mode.json 2>&1"), format!("grep -n night {KB}/mode.json 2>/dev/null")] {
            assert_eq!(bash(&c), None, "{c:?}");
        }
        for c in ["bash -c 'vlad mode off'", "sh -c \"cd / && vlad mode night\"", "eval \"vlad mode off\"", "echo $(vlad mode off)", "echo `vlad mode off`", "(vlad mode off)", "FOO=1 vlad mode off", "sudo vlad mode off", "a || vlad mode off", "x | vlad mode off", "bash -c \"bash -c 'vlad mode off'\""] {
            assert!(has(&bash(c), "mod"), "{c:?}");
        }
        assert!(has(&bash("vlad mode off"), "ana VLAD'san ana repo dizininden"));
        assert!(has(&edit("Write", &format!("{KB}/mode.json")), "vlad task ask"));
        assert!(has(&check_worker_mode("Write", &input(&[("file_path", "/herhangi/mode.json")]), None, None, None).unwrap(), "mode.json"));
    }

    #[test]
    fn exact_messages() {
        assert_eq!(bash("vlad mode off").unwrap(), format!("{WHY}; yalnız `vlad mode status` serbest"));
        assert_eq!(edit("Write", &format!("{KB}/mode.json")).unwrap(), format!("{WHY} (mode.json: {KB}/mode.json)"));
    }

    #[test]
    fn notebook_fallback_and_types() {
        let mut ti = ToolInput::default();
        ti.fields[1] = Val::Null;
        ti.fields[2] = Val::Str(format!("{KB}/mode.json"));
        assert!(check_worker_mode("NotebookEdit", &ti, Some(KB), Some(HOME), Some("/")).unwrap().is_some());
        ti.fields[1] = Val::Other; // file_path: 5 → notebook_path'e düşmez
        assert_eq!(check_worker_mode("NotebookEdit", &ti, Some(KB), Some(HOME), Some("/")).unwrap(), None);
    }

    #[test]
    fn expand_and_substitute() {
        let h = sys::homedir().unwrap();
        assert_eq!(expand("~/x").unwrap(), format!("{h}/x"));
        assert_eq!(expand("~x").unwrap(), "~x");
        assert_eq!(expand("a~/x").unwrap(), "a~/x");
        assert_eq!(expand("${HOME}/a$HOME}b${HOMEc$HOM").unwrap(), format!("{h}/a{h}b{h}c$HOM"));
        assert_eq!(substitute("a$$b$&c$`d$'e$1$", "M", "B", "A"), "a$bMcBdAe$1$");
    }

    #[test]
    fn brace_expand_cases() {
        assert_eq!(brace_expand("a{b,c}d", 0), vec!["abd", "acd"]);
        assert_eq!(brace_expand("{a}{b,c}", 0), vec!["{a}{b,c}"]);
        assert_eq!(brace_expand("{a,b}{c,d}", 0), vec!["ac", "ad", "bc", "bd"]);
        assert_eq!(brace_expand("{a,{b,c}}", 0), ["{a,b}", "{a,c}"].iter().flat_map(|s| brace_expand(s, 1)).collect::<Vec<_>>());
        let many = "{1,2,3,4,5,6,7,8,9}{1,2,3,4,5,6,7,8,9}";
        assert_eq!(brace_expand(many, 0).len(), 64);
        // erken çıkış ilk 64 sonucu değiştirmez
        let full: Vec<String> = (1..=9).flat_map(|a| (1..=9).map(move |b| format!("{a}{b}"))).take(64).collect();
        assert_eq!(brace_expand(many, 0), full);
    }

    // K1 (T20261127-25): 5×60 grup patlaması (60^5 çağrı) kancayı askıda bırakıyordu (Claude Code'da fail-open)
    #[test]
    fn brace_blowup_bounded() {
        let g = format!("{{{}}}", (0..60).map(|i| format!("a{i}")).collect::<Vec<_>>().join(","));
        let t0 = std::time::Instant::now();
        assert_eq!(brace_expand(&format!("/{}", g.repeat(5)), 0).len(), 64);
        assert!(bash(&format!("ls /{}; echo ok", g.repeat(5))).is_none());
        assert!(t0.elapsed() < std::time::Duration::from_secs(1), "{:?}", t0.elapsed());
    }

    #[test]
    fn segments_split() {
        assert_eq!(segments("a; b && c | d (e) `f`"), vec!["a", "b", "c", "d", "e)", "f"]);
        assert_eq!(segments("v\"la\"d mode 'x;y' a\\;b"), vec!["vlad mode x;y a;b"]);
        assert_eq!(segments("x \\"), vec!["x"]);
    }

    struct Tmp {
        root: String,
    }
    impl Tmp {
        fn new(tag: &str) -> Tmp {
            static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let k = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let base = std::env::temp_dir().join(format!("pg-rs-{}-{}-{}", tag, std::process::id(), k));
            let _ = std::fs::remove_dir_all(&base);
            std::fs::create_dir_all(&base).unwrap();
            let root = std::fs::canonicalize(&base).unwrap().to_string_lossy().into_owned();
            let tmp = std::fs::canonicalize(std::env::temp_dir()).unwrap().to_string_lossy().into_owned();
            assert!(root.starts_with(&tmp), "geçici dizin dışı: {root}");
            let secret = format!("{root}/.vlad-secret");
            std::fs::create_dir_all(format!("{secret}/approver")).unwrap();
            std::fs::create_dir_all(format!("{root}/wt")).unwrap();
            std::fs::write(format!("{secret}/mode.key"), "k").unwrap();
            set_secret_dir_for_tests(Some(secret));
            Tmp { root }
        }
        fn secret(&self) -> String {
            format!("{}/.vlad-secret", self.root)
        }
        fn cwd(&self) -> String {
            format!("{}/wt", self.root)
        }
        fn run(&self, tool: &str, pairs: &[(&str, &str)], at: &str) -> Option<String> {
            check_worker_mode(tool, &input(pairs), None, Some(HOME), Some(at)).unwrap()
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            set_secret_dir_for_tests(None);
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    // K1 (T20261128-01): test/hooks/mode-guard.test.ts APFS ad eşdeğerleri
    #[test]
    fn apfs_fold_equivalents() {
        let prot = ["~/.claude/ſettings.json".to_string(), "/Users/x/.claude/settings.local.jſon".into(), format!("{HOME}/vlad.config.local.jſon"), format!("{HOME}/vlad.conﬁg.json"), format!("{KB}/mode.jſon"), format!("{HOME}/diſt/hoo\u{212A}s/x.js"), "~/.claude/ſettingſ.json".into()];
        for p in &prot {
            for t in ["Edit", "Write", "MultiEdit", "NotebookEdit"] {
                assert!(edit(t, p).is_some(), "{t} {p}");
            }
            for c in [format!("echo {{}} > {p}"), format!("tee {p}"), format!("cp x {p}")] {
                assert!(bash(&c).is_some(), "{c:?}");
            }
        }
        for c in ["cat ~/.vlad-ſecret/mode.key", "cat ~/.VLAD-ſECRET/mode.key"] {
            assert!(has(&bash(c), "anahtar"), "{c:?}");
        }
        assert!(has(&check_worker_mode("Read", &input(&[("file_path", "~/.vlad-ſecret/mode.key")]), Some(KB), Some(HOME), Some("/work/wt")).unwrap(), "anahtar"));
        assert!(has(&check_worker_mode("Grep", &input(&[("pattern", "x"), ("path", "~/.vlad-ſecret")]), Some(KB), Some(HOME), Some("/work/wt")).unwrap(), "anahtar"));
        for c in ["ſed -i s/a/b/ ~/.claude/settings.json", "baſh -c 'echo x > ~/.claude/settings.json'", "inſtall x ~/.claude/settings.json", "aw\u{212A} 1 x | ſponge ~/.claude/settings.json", "aw\u{212A} -i inplace 1 ~/.claude/settings.json"] {
            assert!(bash(c).is_some(), "{c:?}");
        }
        for c in ["echo ß ﬁ", "cat ~/.claude/ſettings.json", "ſed -n 1p ~/.claude/settings.json"] {
            assert_eq!(bash(c), None, "{c:?}");
        }
        assert_eq!(edit("Write", "/work/wt/src/ſettings.json"), None);
    }

    // test/hooks/mode-guard-bypass.test.ts K1
    #[test]
    fn apfs_fold_glob_secret() {
        let t = Tmp::new("fold");
        let (cwd, root) = (t.cwd(), t.root.clone());
        for c in [format!("cat {root}/.v*-ſecret/mode.key"), format!("cat {root}/.vlad-ſec*/mode.key"), format!("ls {root}/.vlad-{{ſecret,x}}"), format!("cat {root}/.vlad-ſecret/mode.\u{212A}ey")] {
            assert!(t.run("Bash", &[("command", &c)], &cwd).is_some(), "{c:?}");
        }
        let ev = format!("{root}/straß");
        std::fs::create_dir_all(format!("{ev}/.vlad-secret")).unwrap();
        set_secret_dir_for_tests(Some(format!("{ev}/.vlad-secret")));
        for c in [format!("cat {root}/strass/.v*/mode.key"), format!("cat {root}/straſſ/.vlad-*/mode.key")] {
            assert!(t.run("Bash", &[("command", &c)], &cwd).is_some(), "{c:?}");
        }
        assert!(t.run("Read", &[("file_path", &format!("{root}/strass/.vlad-secret/mode.key"))], &cwd).is_some());
        // review K1-1: kabuk `?`/`[ß]` tek karakteri ß'ye açar
        for c in [format!("cat {root}/stra?/.v*/mode.key"), format!("ls {root}/stra?/.v*"), format!("cat {root}/stra[ß]/.vlad-secre?/mode.key")] {
            assert!(t.run("Bash", &[("command", &c)], &cwd).is_some(), "{c:?}");
        }
    }

    // review K1-2: katlanmış adlı symlink ham adla çözülür (Linux/NTFS/harf duyarlı APFS'te ſx ≠ sx)
    #[cfg(unix)]
    #[test]
    fn apfs_fold_raw_symlink() {
        let t = Tmp::new("foldln");
        let cwd = t.cwd();
        std::os::unix::fs::symlink(t.secret(), format!("{cwd}/ſx")).unwrap();
        for (tool, k) in [("Read", "file_path"), ("Write", "file_path")] {
            assert!(t.run(tool, &[(k, "ſx/mode.key")], &cwd).is_some(), "{tool}");
        }
    }

    #[test]
    fn fold_table() {
        assert_eq!(crate::text::fold("ſ \u{212A} ß ẞ ﬀ ﬁ ﬂ ﬃ ﬄ ﬅ ﬆ ı İ x"), "s k ss ss ff fi fl ffi ffl st st ı İ x");
    }

    // test/hooks/mode-guard-read.test.ts
    #[test]
    fn read_tools_secret() {
        let t = Tmp::new("read");
        let (secret, cwd, root) = (t.secret(), t.cwd(), t.root.clone());
        symlink(&secret, format!("{cwd}/link")).unwrap();
        for p in [format!("{secret}/mode.key"), format!("{secret}/approver/pending.json"), format!("{cwd}/../.vlad-secret/mode.key"), "link/mode.key".into(), format!("{cwd}/link"), "~/.vlad-secret/mode.key".into()] {
            assert!(t.run("Read", &[("file_path", &p)], &cwd).is_some(), "{p}");
        }
        assert!(t.run("Grep", &[("pattern", "x"), ("path", &secret)], &cwd).is_some());
        assert!(t.run("Grep", &[("pattern", "x"), ("glob", &format!("{secret}/**"))], &cwd).is_some());
        assert!(t.run("Glob", &[("pattern", &format!("{secret}/approver/*.json"))], &cwd).is_some());
        assert!(t.run("Glob", &[("pattern", "*"), ("path", &format!("{secret}/approver"))], &cwd).is_some());
        symlink(&secret, format!("{cwd}/s")).unwrap();
        assert!(t.run("Grep", &[("pattern", "."), ("path", &root)], &cwd).is_some());
        assert!(t.run("Grep", &[("pattern", "."), ("path", "/")], &cwd).is_some());
        assert!(t.run("Glob", &[("pattern", "**/mode.key"), ("path", &root)], &cwd).is_some());
        assert!(t.run("Glob", &[("pattern", &format!("{root}/*/mode.key"))], &cwd).is_some());
        assert!(t.run("Glob", &[("pattern", &format!("{root}/.vlad-{{secret,x}}/*"))], &cwd).is_some());
        assert!(t.run("Glob", &[("pattern", "s/*/channel.json")], &cwd).is_some());
        // F-vlad-347
        std::fs::write(format!("{root}/notes.txt"), "x").unwrap();
        std::fs::create_dir_all(format!("{root}/elsewhere")).unwrap();
        std::fs::write(format!("{root}/elsewhere/a.ts"), "x").unwrap();
        assert_eq!(t.run("Read", &[("file_path", &format!("{root}/elsewhere/a.ts"))], &root), None);
        assert_eq!(t.run("Read", &[("file_path", "notes.txt")], &root), None);
        assert!(t.run("Read", &[("file_path", &format!("{secret}/mode.key"))], &root).is_some());
        assert!(t.run("Read", &[("file_path", ".vlad-secret/mode.key")], &root).is_some());
        assert!(t.run("Grep", &[("pattern", "x")], &root).is_some());
        assert!(t.run("Glob", &[("pattern", "**/*.ts")], &root).is_some());
        std::fs::write(format!("{cwd}/a.ts"), "x").unwrap();
        assert_eq!(t.run("Read", &[("file_path", &format!("{cwd}/a.ts"))], &cwd), None);
        assert_eq!(t.run("Read", &[("file_path", "a.ts")], &cwd), None);
        assert_eq!(t.run("Grep", &[("pattern", "mode\\.key"), ("path", &cwd)], &cwd), None);
        assert_eq!(t.run("Glob", &[("pattern", &format!("{cwd}/**/*.ts"))], &cwd), None);
    }

    // test/hooks/mode-guard-bypass.test.ts
    #[test]
    fn bypass_cases() {
        let t = Tmp::new("bypass");
        let (secret, cwd, root) = (t.secret(), t.cwd(), t.root.clone());
        let b = |c: &str, at: &str| t.run("Bash", &[("command", c)], at);
        for c in [format!("cat {secret}/mode.key"), "cat ~/.vlad-secret/mode.key".into(), format!("cat \"{root}/.vlad-sec\"ret/mode.key"), format!("cat {secret}/*"), "cat ../.vlad-secret/mode.key".into(), format!("cd {root} && cat .vlad-secret/mode.key"), "cd ~ && cat .vlad-secret/mode.key".into(), format!("D={root}; cat $D/.vlad-secret/mode.key"), format!("echo x; cat $(echo {secret})/mode.key")] {
            assert!(b(&c, &cwd).is_some(), "{c}");
        }
        assert!(b("cat .vlad-secret/mode.key", &root).is_some());
        let name = root.rsplit('/').next().unwrap().to_string();
        for c in ["cat ../*/.vlad-secret/mode.key".into(), format!("cat ../{{{name},foo}}/.vlad-secret/mode.key"), format!("cat ./../{name}/.vlad-secret/mode.key"), "cat ..//*/.vlad-secret/*".into(), "cat ../?*/.vlad-secret/x".into(), "cat ../[a-z]*/.vlad-secret/x".into(), format!("grep -f{secret}/mode.key /dev/null")] {
            for at in [&cwd, &root] {
                assert!(b(&c, at).is_some(), "{at}: {c}");
            }
        }
        assert!(t.run("Grep", &[("pattern", ".")], &root).is_some());
        assert!(t.run("Glob", &[("pattern", "**/mode.key")], &root).is_some());
        assert_eq!(t.run("Grep", &[("pattern", ".")], &cwd), None);
        let deep = format!("{cwd}/a");
        std::fs::create_dir_all(&deep).unwrap();
        assert!(t.run("Glob", &[("pattern", "../.vlad-secret/*"), ("path", &cwd)], &deep).is_some());
        assert!(t.run("Glob", &[("pattern", "../.vlad-secret/mode.key"), ("path", &cwd)], &cwd).is_some());
        assert!(t.run("Glob", &[("pattern", "**/../x/*")], &cwd).is_some());
        assert!(t.run("Grep", &[("pattern", "x"), ("glob", "*/../*.ts")], &cwd).is_some());
        assert_eq!(t.run("Glob", &[("pattern", "src/**/*.ts")], &cwd), None);
        symlink(&secret, format!("{cwd}/s")).unwrap();
        symlink(format!("{secret}/yeni.json"), format!("{cwd}/dangling")).unwrap();
        for tool in ["Write", "Edit", "MultiEdit"] {
            assert!(t.run(tool, &[("file_path", "s/mode.key")], &cwd).is_some(), "{tool}");
            assert!(t.run(tool, &[("file_path", "dangling")], &cwd).is_some(), "{tool} dangling");
        }
        assert!(t.run("NotebookEdit", &[("notebook_path", "s/x.ipynb")], &cwd).is_some());
        assert_eq!(t.run("Write", &[("file_path", "ok.txt")], &cwd), None);
        for c in [format!("cat {root}/.v*/mode.key"), format!("cat {root}/.vlad-*/mode.key"), format!("cat {root}/.*/mode.key"), format!("cat {root}/.[v]lad-secret/mode.key"), format!("cat {root}/.vlad-{{secret,x}}/mode.key"), format!("ln -s {root}/.vlad-sec* x"), format!("cat {root}/.?lad-secret/mode.key")] {
            assert!(b(&c, &cwd).is_some(), "{c}");
        }
        for c in [format!("ls {root}/*.txt"), format!("cat {root}/.gitignore"), format!("ls {root}/wt/*"), "grep -r '.*' src".into(), "ls ~/dev/*".into()] {
            assert_eq!(b(&c, &cwd), None, "{c}");
        }
    }
}
