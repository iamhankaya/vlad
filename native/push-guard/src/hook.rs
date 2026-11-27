//! src/hooks/push-guard-hook.ts akışı birebir: yalnız çalışan oturumlarında mod koruması + push doğrulaması;
//! herhangi bir istisnada (Err/panic) ham girdiye bakan fail-closed catch yolu.

use crate::json::{self, Kind, Val};
use crate::mode_guard::{check_worker_mode, MODE_GUARD_TOOLS};
use crate::path::{basename, dirname, is_absolute, join, resolve};
use crate::push_guard::check_worker_push;
use crate::sys;
use crate::text::{js_re, js_trim};
use regex::Regex;
use std::sync::OnceLock;

#[derive(Debug, PartialEq)]
pub enum Outcome {
    /// çıkış 0
    Allow,
    /// stderr + çıkış 2
    Block(String),
    /// yakalanmamış istisna (Node: çıkış 1)
    Crash(String),
}

fn re(cell: &'static OnceLock<Regex>, src: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(&js_re(src)).expect("statik regex"))
}

/// `ownId(cwd)`: geçerli VLAD_TASK_ID ya da cwd'nin `vlad/T…` dalı.
pub fn own_id(cwd: &str) -> Option<String> {
    static TASK: OnceLock<Regex> = OnceLock::new();
    static BRANCH: OnceLock<Regex> = OnceLock::new();
    if let Some(e) = sys::env("VLAD_TASK_ID") {
        if !e.is_empty() && re(&TASK, r"^T[0-9]{8}-[0-9]+$").is_match(&e) {
            return Some(e);
        }
    }
    if sys::head_cannot_be_vlad(cwd) {
        return None; // git çıktısı kalıba uyamaz: süreç başlatmadan aynı sonuç
    }
    let b = sys::git_symbolic_ref(cwd)?;
    re(&BRANCH, r"^vlad/(T[0-9]{8}-[0-9]+)$").captures(js_trim(&b)).map(|c| c[1].to_string())
}

/// mode/guard.ts `inWorkerWorktreeDir`: cwd ya da bir atası `<repo>-wt/T<yyyymmdd>-<n>`; realpath çözülemezse true.
pub fn in_worker_worktree_dir(cwd: &str) -> bool {
    static T: OnceLock<Regex> = OnceLock::new();
    static WT: OnceLock<Regex> = OnceLock::new();
    let Some(mut d) = sys::realpath(cwd) else { return true };
    loop {
        let parent = dirname(&d);
        if parent == d {
            return false;
        }
        if re(&T, r"^[tT][0-9]{8}-[0-9]+$").is_match(&basename(&d)) && re(&WT, r"-[wW][tT]$").is_match(&basename(&parent)) {
            return true;
        }
        d = parent;
    }
}

/// config-layer.ts `readObject`: yoksa boş nesne; okunamaz/geçersiz/nesne değilse hata.
fn read_object(file: &str) -> Result<Option<json::ConfigObj>, String> {
    let Some(text) = sys::read_file_if_exists(file).map_err(|e| format!("config okunamadı ({}): {}", file, e))? else { return Ok(None) };
    let c = json::parse_config(&text).map_err(|e| format!("config okunamadı ({}): {}", file, e))?;
    if c.kind != Kind::Object {
        return Err(format!("config okunamadı ({}): nesne olmalı", file));
    }
    Ok(Some(c))
}

/// `readConfigLayers(home).kbDir` (JS sığ birleşim + `__proto__` atama semantiği).
fn config_kb_dir(home: &str) -> Result<Val, String> {
    let main = read_object(&join(&[home, "vlad.config.json"]))?;
    let local = read_object(&join(&[home, "vlad.config.local.json"]))?;
    let mut own = main.as_ref().map_or(Val::Missing, |m| m.kb_dir.clone());
    let has_own_proto =main.as_ref().is_some_and(|m| m.proto != Val::Missing);
    let mut proto_kb = Val::Missing;
    if let Some(l) = &local {
        match &l.kb_dir {
            Val::Missing => {}
            Val::Null => own = Val::Missing, // null anahtarı siler
            v => own = v.clone(),
        }
        match &l.proto {
            Val::Missing => {}
            Val::Null => {} // delete merged.__proto__: yalnız kendi özelliği silinir, prototip değişmez
            Val::Obj if !has_own_proto => proto_kb = l.proto_kb_dir.clone(), // prototip = o nesne
            Val::Arr if !has_own_proto => proto_kb = Val::Missing,
            _ => {} // kendi veri özelliği güncellenir ya da ilkel değer (setter yok sayar)
        }
    }
    Ok(if own != Val::Missing { own } else { proto_kb })
}

/// `resolveKbDir(home).dir`; Err = TS'te dışarı fırlayan hata (VLAD_KB_DIR çözümü).
fn resolve_kb_dir(home: &str) -> Result<String, String> {
    if let Some(e) = sys::env("VLAD_KB_DIR").filter(|e| !e.is_empty()) {
        return resolve(&[home, &e]);
    }
    // config dalı try içinde: okuma/çözüm hatası eski konuma düşer
    if let Ok(Val::Str(k)) = config_kb_dir(home) {
        if !k.is_empty() {
            if is_absolute(&k) {
                return Ok(k);
            }
            if let Ok(r) = resolve(&[home, &k]) {
                return Ok(r);
            }
        }
    }
    Ok(join(&[home, "kb"]))
}

fn try_part(raw: &str) -> Result<Outcome, String> {
    let j = json::parse(raw)?;
    let Some(tool) = j.tool_name.as_str().filter(|t| MODE_GUARD_TOOLS.contains(t)) else { return Ok(Outcome::Allow) };
    let cwd = match &j.cwd {
        Val::Str(s) => s.clone(),
        _ => sys::process_cwd()?,
    };
    let id = own_id(&cwd);
    let worker = id.is_some() || sys::env("VLAD_TASK_ID").is_some_and(|v| !js_trim(&v).is_empty()) || in_worker_worktree_dir(&cwd);
    if !worker {
        return Ok(Outcome::Allow); // ana VLAD / kullanıcı oturumu
    }
    // TS getVladHome() hiç başarısız olmaz; ikili konumu çözülemezse korumaları sessizce atlamak yerine catch yolu (M3)
    let h = sys::vlad_home()?;
    let (home, kb) = (Some(h.clone()), resolve_kb_dir(&h).ok());
    let input = j.tool_input.clone().unwrap_or_default();
    if let Some(why) = check_worker_mode(tool, &input, kb.as_deref(), home.as_deref(), Some(&cwd))? {
        return Ok(Outcome::Block(why));
    }
    let cmd = input.get("command").as_str();
    let Some(cmd) = cmd.filter(|_| tool == "Bash") else { return Ok(Outcome::Allow) };
    if id.is_none() && !sys::env_truthy("VLAD_TASK_ID") {
        return Ok(Outcome::Allow);
    }
    Ok(match check_worker_push(cmd, id.as_deref()) {
        Some(why) => Outcome::Block(why.to_string()),
        None => Outcome::Allow,
    })
}

fn wt_dir(cwd: &str) -> bool {
    static WT: OnceLock<Regex> = OnceLock::new();
    re(&WT, r"[\\/][^\\/]*-[wW][tT][\\/][tT][0-9]{8}-[0-9]+(?:[\\/]|$)").is_match(cwd)
}

/// catch bloğu. `process.cwd()` burada fırlarsa Node yakalanmamış istisnayla çıkar (1).
fn catch_part(raw: &str, msg: &str) -> Outcome {
    static TOOL: OnceLock<Regex> = OnceLock::new();
    static PUSH: OnceLock<Regex> = OnceLock::new();
    let env_set = sys::env_truthy("VLAD_TASK_ID");
    // asWorker = env || ownId(process.cwd()) !== null || WT_DIR.test(process.cwd())
    let as_worker = if env_set {
        true
    } else {
        let cwd = match sys::process_cwd() {
            Ok(c) => c,
            Err(e) => return Outcome::Crash(e),
        };
        own_id(&cwd).is_some() || wt_dir(&cwd)
    };
    if as_worker && re(&TOOL, r#""tool_name"⟨s⟩*:⟨s⟩*"(?:Read|Grep|Glob|NotebookEdit|Edit|Write|MultiEdit)""#).is_match(raw) {
        return Outcome::Block(format!("mod-koruma hatası (fail-closed): {}", msg));
    }
    let mentions_push = re(&PUSH, r"⟨b⟩git⟨b⟩(?s:.)*⟨b⟩push⟨b⟩").is_match(raw);
    let fire = mentions_push || {
        words_hit(raw) && {
            if env_set {
                true
            } else {
                let cwd = match sys::process_cwd() {
                    Ok(c) => c,
                    Err(e) => return Outcome::Crash(e),
                };
                own_id(&cwd).is_some() || wt_dir(&cwd)
            }
        }
    };
    if fire {
        return Outcome::Block(format!("push-guard hatası (fail-closed): {}", msg));
    }
    Outcome::Allow
}

/// `/mode|settings|vlad\.config|dist.hooks|vlad-secret/i` (`.` = satır sonu dışında TEK UTF-16 birimi).
fn words_hit(raw: &str) -> bool {
    static W: OnceLock<Regex> = OnceLock::new();
    re(&W, r"(?i-u:mode|settings|vlad\.config|vlad-secret)|(?i-u:dist)[^\n\r\x{2028}\x{2029}\x{10000}-\x{10FFFF}](?i-u:hooks)").is_match(raw)
}

/// Kanca işinin yığını: `real` en çok MAX_REAL_FRAMES düzey iner; ana iş parçacığının (8 MB, test: 2 MB) yetip
/// yetmemesine bırakmayız. Yığın taşması süreci yakalanamaz biçimde düşürür (çıkış 134 = Claude Code'da fail-open).
const STACK: usize = 64 << 20;

pub fn run(raw: &str) -> Outcome {
    let owned = raw.to_string();
    let worker = std::thread::Builder::new().stack_size(STACK).spawn(move || {
        // panik de TS'teki istisna gibi catch yoluna gider (fail-closed korunur)
        let r = std::panic::catch_unwind(|| try_part(&owned)).unwrap_or_else(|p| {
            Err(p.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| p.downcast_ref::<String>().cloned()).unwrap_or_else(|| "panic".into()))
        });
        match r {
            Ok(o) => o,
            Err(e) => catch_part(&owned, &e),
        }
    });
    match worker.map(|h| h.join()) {
        Ok(Ok(o)) => o,
        // iş parçacığı açılamadı ya da catch yolu da paniğe düştü: yine catch yolu (aynı iş parçacığında, sığ)
        Ok(Err(_)) => catch_part(raw, "panic"),
        Err(e) => catch_part(raw, &e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worktree_dir_detection() {
        assert!(in_worker_worktree_dir("/nonexistent-xyz/vlad-wt/T20261127-25")); // çözülemez → true
        assert!(in_worker_worktree_dir(""));
        assert!(!in_worker_worktree_dir("/"));
        let base = std::env::temp_dir().join(format!("pg-rs-wt-{}", std::process::id()));
        let wt = base.join("Repo-WT").join("t20261127-01").join("sub");
        std::fs::create_dir_all(&wt).unwrap();
        assert!(in_worker_worktree_dir(wt.to_str().unwrap()));
        assert!(!in_worker_worktree_dir(base.to_str().unwrap()));
        let real = std::fs::canonicalize(&base).unwrap();
        assert!(real.starts_with(std::fs::canonicalize(std::env::temp_dir()).unwrap()));
        std::fs::remove_dir_all(&real).unwrap();
    }

    #[test]
    fn deep_path_end_to_end_blocks() {
        // C1: derin yönlendirme hedefi + push; TS RangeError → catch → ret. Varsayılan (2 MB) test yığınında bile run() düşmemeli.
        std::env::set_var("VLAD_TASK_ID", "T20261127-99");
        let raw = format!(r#"{{"tool_name":"Bash","tool_input":{{"command":"ls > /pg-rs-yok{}; git push -f origin main"}},"cwd":"/"}}"#, "/a".repeat(20000));
        let o = run(&raw);
        assert!(matches!(&o, Outcome::Block(m) if m.starts_with("push-guard hatası (fail-closed): ")), "{o:?}");
        let raw = format!(r#"{{"tool_name":"Read","tool_input":{{"file_path":"/pg-rs-yok{}"}},"cwd":"/"}}"#, "/a".repeat(20000));
        assert!(matches!(run(&raw), Outcome::Block(m) if m.starts_with("mod-koruma hatası (fail-closed): ")));
    }

    #[test]
    fn wt_dir_regex() {
        assert!(wt_dir("/a/vlad-wt/T20261127-25"));
        assert!(wt_dir("/a/x-WT/t20261127-25/"));
        assert!(!wt_dir("/a/vlad-wt/T2026112-25"));
        assert!(!wt_dir("vlad-wt/T20261127-25"));
    }

    #[test]
    fn words_regex() {
        assert!(words_hit("xx dist/hooks"));
        assert!(words_hit("SETTINGS"));
        assert!(!words_hit("dist\nhooks"));
        assert!(!words_hit("dist😀hooks")); // JS `.` tek kod birimi: vekil çifti iki birim
        assert!(words_hit("distéhooks"));
        assert!(!words_hit("vlad config"));
    }

    #[test]
    fn broken_json_catch_messages() {
        let o = catch_part("{bozuk", "x");
        assert_eq!(o, Outcome::Allow);
        assert_eq!(catch_part(r#"{"tool_input":{"command":"git push origin main""#, "e"), Outcome::Block("push-guard hatası (fail-closed): e".into()));
    }
}
