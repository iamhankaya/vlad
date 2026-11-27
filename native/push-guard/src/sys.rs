//! İşletim sistemi erişimi: Node API'lerinin karşılıkları (process.cwd, realpathSync.native, lstat, readlink,
//! os.homedir, os.userInfo, execFileSync git). Dosya sistemine yalnız okuma yapılır.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::OnceLock;
use std::time::Duration;

/// `process.cwd()`; silinmiş dizinde Node gibi hata.
pub fn process_cwd() -> Result<String, String> {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("process.cwd failed: {}", e))
}

/// `process.env[name]`; tanımsız = None (boş dize Some("")).
pub fn env(name: &str) -> Option<String> {
    std::env::var_os(name).map(|v| v.to_string_lossy().into_owned())
}

/// JS doğruluk değeri: tanımlı ve boş değil.
pub fn env_truthy(name: &str) -> bool {
    env(name).is_some_and(|v| !v.is_empty())
}

/// `fs.realpathSync.native` (realpath(3)); NUL içeren yol ya da hata = None.
pub fn realpath(p: &str) -> Option<String> {
    if p.contains('\0') {
        return None;
    }
    std::fs::canonicalize(p).ok().map(|x| x.to_string_lossy().into_owned())
}

/// `lstatSync(p).isSymbolicLink()`; hata = None (Node fırlatır, çağıran yakalar).
pub fn lstat_is_symlink(p: &str) -> Option<bool> {
    if p.contains('\0') {
        return None;
    }
    std::fs::symlink_metadata(p).ok().map(|m| m.file_type().is_symlink())
}

pub fn readlink(p: &str) -> Option<String> {
    if p.contains('\0') {
        return None;
    }
    std::fs::read_link(p).ok().map(|x| x.to_string_lossy().into_owned())
}

/// `os.homedir()`: HOME tanımlıysa (boş olsa da) o, değilse passwd kaydı.
pub fn homedir() -> Result<String, String> {
    match env("HOME") {
        Some(h) => Ok(h),
        None => user_homedir(),
    }
}

/// `os.userInfo().homedir`: etkin kullanıcının passwd kaydı (HOME'a bakmaz). Süreç başına bir kez sorulur.
pub fn user_homedir() -> Result<String, String> {
    static CELL: OnceLock<Result<String, String>> = OnceLock::new();
    CELL.get_or_init(|| {
        let uid = nix::unistd::Uid::effective();
        match nix::unistd::User::from_uid(uid) {
            Ok(Some(u)) => Ok(u.dir.to_string_lossy().into_owned()),
            Ok(None) => Err("A system error occurred: uv_os_get_passwd returned ENOENT (no such file or directory)".into()),
            Err(e) => Err(format!("A system error occurred: uv_os_get_passwd returned {}", e)),
        }
    })
    .clone()
}

/// `execFileSync("git", ["symbolic-ref","--short","HEAD"], {cwd, stdio:["ignore","pipe","ignore"], timeout: 5000})`.
/// Başarısızlık (spawn hatası, sıfır olmayan çıkış, sinyal, zaman aşımı) = None.
pub fn git_symbolic_ref(cwd: &str) -> Option<String> {
    git_symbolic_ref_timeout(cwd, Duration::from_millis(5000))
}

pub fn git_symbolic_ref_timeout(cwd: &str, timeout: Duration) -> Option<String> {
    // Node: boş cwd → spawn ENOENT; NUL içeren cwd → ERR_INVALID_ARG_VALUE
    if cwd.is_empty() || cwd.contains('\0') {
        return None;
    }
    let start = std::time::Instant::now();
    let mut child = Command::new("git")
        .args(["symbolic-ref", "--short", "HEAD"])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut out = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let r = out.read_to_end(&mut buf).map(|_| buf);
        let _ = tx.send(r);
    });
    match rx.recv_timeout(timeout.saturating_sub(start.elapsed())) {
        Ok(Ok(buf)) => {
            // stdout kapandı; çıkış durumunu yalnız kalan sürede bekle (M2: stdout'u kapatıp çıkmayan süreç)
            loop {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        return status.success().then(|| String::from_utf8_lossy(&buf).into_owned());
                    }
                    Ok(None) if start.elapsed() < timeout => std::thread::sleep(Duration::from_micros(200)),
                    _ => {
                        let _ = child.kill();
                        let _ = child.wait();
                        return None;
                    }
                }
            }
        }
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            None
        }
    }
}

/// Hız ön kontrolü (yalnız Rust'ta; karar değişmez): `git symbolic-ref --short HEAD` çıktısının `vlad/T…` kalıbına
/// uyamayacağı **kesin** ise true (çağıran git'i hiç başlatmaz, sonuç TS'teki gibi "dal yok/eşleşmedi"). Kesin olmayan
/// her durumda false (git yine çalışır): repo keşfini etkileyen GIT_* ortamı, çözülemeyen cwd, bare/gitdir adayı dizin,
/// geçersiz ya da alışılmadık `.git`, symlink/reftable HEAD, ya da HEAD hedefinde `vlad/T<8 rakam>-<n>` geçmesi.
/// Kısaltma (`--short`) yalnız önek siler (`refs/remotes/<x>/HEAD` → `<x>` dahil), bu yüzden hedef dizesinde kalıp
/// hiç geçmiyorsa çıktı da kalıba uyamaz; ayrık HEAD'de git başarısız olur (null).
pub fn head_cannot_be_vlad(cwd: &str) -> bool {
    let git_env = std::env::vars_os().any(|(k, _)| k.to_string_lossy().starts_with("GIT_"));
    head_cannot_be_vlad_with(cwd, git_env)
}

fn head_cannot_be_vlad_with(cwd: &str, git_env: bool) -> bool {
    use std::path::Path;
    if cwd.is_empty() || cwd.contains('\0') {
        return true; // Node spawn'ı zaten başarısız (null)
    }
    if git_env {
        return false;
    }
    let Ok(real) = std::fs::canonicalize(cwd) else { return false };
    if !real.is_dir() {
        return false;
    }
    let mut d: &Path = &real;
    loop {
        // git her düzeyde önce <d>/.git'e, sonra <d>'nin kendisinin gitdir olup olmadığına bakar
        let dot = d.join(".git");
        match std::fs::metadata(&dot) {
            Ok(m) => {
                let gitdir = if m.is_dir() {
                    dot
                } else if m.is_file() {
                    let Ok(t) = std::fs::read_to_string(&dot) else { return false };
                    let Some(rest) = t.strip_prefix("gitdir: ") else { return false };
                    let rest = rest.trim_end_matches(['\n', '\r']);
                    if rest.is_empty() || rest.contains('\n') {
                        return false;
                    }
                    d.join(rest)
                } else {
                    return false;
                };
                return gitdir_head_cannot_be_vlad(&gitdir);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return false,
        }
        if d.join("HEAD").symlink_metadata().is_ok() {
            return false; // bare repo / gitdir adayı
        }
        match d.parent() {
            Some(p) => d = p,
            None => return true, // repo yok: git başarısız (null)
        }
    }
}

fn gitdir_head_cannot_be_vlad(gitdir: &std::path::Path) -> bool {
    static PAT: OnceLock<regex::Regex> = OnceLock::new();
    // git `is_git_directory`: geçersiz .git dizininde keşif üst dizine sürer (I1, review). Bağlı worktree (commondir)
    // ve erişilemeyen objects/refs durumunu taklit etmek yerine git'e bırak: hızlı yol yalnız sade, erişilebilir repoda.
    use nix::unistd::{access, AccessFlags};
    let usable = |d: std::path::PathBuf| d.is_dir() && access(&d, AccessFlags::X_OK).is_ok();
    let valid = gitdir.symlink_metadata().is_ok_and(|m| m.is_dir())
        && gitdir.join("commondir").symlink_metadata().is_err()
        && usable(gitdir.join("objects"))
        && usable(gitdir.join("refs"));
    if !valid || gitdir.join("reftable").symlink_metadata().is_ok() {
        return false;
    }
    let head = gitdir.join("HEAD");
    match head.symlink_metadata() {
        Ok(m) if m.is_file() => {}
        _ => return false,
    }
    let Ok(t) = std::fs::read_to_string(&head) else { return false };
    let t = t.trim_end_matches(['\n', '\r']);
    if let Some(target) = t.strip_prefix("ref: ") {
        let target = target.trim();
        if !target.starts_with("refs/") || target == "refs/heads/.invalid" || target.contains(char::is_whitespace) {
            return false;
        }
        let pat = PAT.get_or_init(|| regex::Regex::new(r"vlad/T[0-9]{8}-[0-9]+").expect("statik regex"));
        if pat.is_match(target) || target.split('/').any(|c| c.is_empty() || c == "." || c == "..") {
            return false;
        }
        // Codex P2: hedef ref'in kendisi symbolic ref olabilir (git zinciri izler). Gevşek ref yoksa (doğmamış dal
        // ya da packed-refs; packed-refs symbolic ref taşımaz) zincir yoktur; düz dosyada `ref:` yoksa sha'dır.
        let loose = gitdir.join(target);
        return match loose.symlink_metadata() {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
            Ok(m) if m.is_file() => match std::fs::read(&loose) {
                Ok(b) => !b.starts_with(b"ref:"),
                Err(_) => false,
            },
            _ => false, // symlink ref, dizin ya da okunamayan: git'e bırak
        };
    }
    // ayrık HEAD (40/64 hex): symbolic-ref başarısız olur
    (t.len() == 40 || t.len() == 64) && t.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `getVladHome()` ikili karşılığı: VLAD_HOME (boş değilse), yoksa ikilinin konumu `<home>/dist/hooks/push-guard` → `<home>`
/// (TS: `dist/kb/home.js` iki üst dizin). Node ana modülün symlink'ini çözer; burada da canonicalize.
pub fn vlad_home() -> Result<String, String> {
    if let Some(h) = env("VLAD_HOME") {
        if !h.is_empty() {
            return Ok(h);
        }
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = std::fs::canonicalize(&exe).unwrap_or(exe);
    let exe = exe.to_string_lossy().into_owned();
    crate::path::resolve(&[&crate::path::dirname(&exe), "..", ".."])
}

/// Dosya içeriği (config katmanı). None = yok (existsSync false), Err = okunamadı.
pub fn read_file_if_exists(p: &str) -> Result<Option<String>, String> {
    if p.contains('\0') {
        return Ok(None);
    }
    // existsSync: stat (symlink izlenir) başarılı mı
    if std::fs::metadata(p).is_err() {
        return Ok(None);
    }
    match std::fs::read(p) {
        Ok(b) => Ok(Some(String::from_utf8_lossy(&b).into_owned())),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_missing_dir_is_none() {
        assert_eq!(git_symbolic_ref("/nonexistent-dir-xyz-123"), None);
        assert_eq!(git_symbolic_ref(""), None);
    }

    fn sh_git(dir: &std::path::Path, args: &[&str]) {
        let ok = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {:?}", args);
    }

    #[test]
    fn head_fast_path_matches_git() {
        let base = std::env::temp_dir().join(format!("pg-rs-head-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&base);
        let base = std::fs::canonicalize(&base).unwrap();
        assert!(base.starts_with(std::fs::canonicalize(std::env::temp_dir()).unwrap()));
        let mk = |name: &str, branch: &str| {
            let d = base.join(name);
            std::fs::create_dir_all(&d).unwrap();
            sh_git(&d, &["init", "-q", "-b", branch]);
            sh_git(&d, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"]);
            d
        };
        let main = mk("main", "main");
        let vlad = mk("vlad", "vlad/T20261127-01");
        let det = mk("det", "main");
        sh_git(&det, &["checkout", "-q", "--detach"]);
        sh_git(&main, &["worktree", "add", "-q", "-b", "vlad/T20261127-02", base.join("wt-vlad").to_str().unwrap()]);
        sh_git(&main, &["worktree", "add", "-q", "-b", "other", base.join("wt-other").to_str().unwrap()]);
        std::fs::create_dir_all(main.join("sub/deep")).unwrap();
        std::fs::create_dir_all(base.join("none")).unwrap();
        // iç .git: HEAD main'i gösterir ama git'e göre geçerli repo değil (commondir yok yere / objects yok)
        for (sub, common) in [("bad1", true), ("bad2", false)] {
            let g = vlad.join(sub).join(".git");
            std::fs::create_dir_all(g.join("refs")).unwrap();
            std::fs::write(g.join("HEAD"), "ref: refs/heads/main\n").unwrap();
            if common {
                std::fs::write(g.join("commondir"), "/nonexistent-pg\n").unwrap();
                std::fs::create_dir_all(g.join("objects")).unwrap();
            }
        }
        let s = |p: &std::path::Path| p.to_str().unwrap().to_string();
        let cases: Vec<(String, bool)> = vec![
            (s(&main), true),
            (s(&main.join("sub/deep")), true),
            (s(&vlad), false),
            (s(&det), true),
            (s(&base.join("wt-vlad")), false),
            (s(&base.join("wt-other")), false), // bağlı worktree (commondir): git'e bırakılır
            (s(&vlad.join("bad1")), false),     // I1: geçersiz iç .git, git üst repoya (vlad/T…) yürür
            (s(&vlad.join("bad2")), false),
            (s(&main.join(".git")), false), // gitdir'in içi: git'e bırak
            (s(&base.join("yok")), false),
            ("".into(), true),
        ];
        for (cwd, want) in &cases {
            assert_eq!(head_cannot_be_vlad_with(cwd, false), *want, "{cwd}");
            if *want {
                // hızlı yol yalnız git'in de kalıba uyan dal döndürmediği yerde devreye girer
                let b = git_symbolic_ref(cwd).unwrap_or_default();
                assert!(!b.trim().starts_with("vlad/T"), "{cwd}: {b}");
            }
        }
        for sub in ["bad1", "bad2"] {
            assert_eq!(git_symbolic_ref(&s(&vlad.join(sub))).unwrap_or_default().trim(), "vlad/T20261127-01", "{sub}");
        }
        assert!(!head_cannot_be_vlad_with(&s(&main), true)); // GIT_* ortamı: her zaman git
        std::fs::write(det.join(".git/HEAD"), "ref: refs/remotes/vlad/T20261127-03/HEAD\n").unwrap();
        assert!(!head_cannot_be_vlad_with(&s(&det), false));
        std::fs::write(det.join(".git/HEAD"), "ref: refs/heads/.invalid\n").unwrap();
        assert!(!head_cannot_be_vlad_with(&s(&det), false));
        // Codex P2: HEAD → refs/heads/alias → refs/heads/vlad/T… (zincirli symbolic ref); git zinciri izler
        std::fs::write(det.join(".git/refs/heads/alias"), "ref: refs/heads/vlad/T20261127-04\n").unwrap();
        std::fs::write(det.join(".git/HEAD"), "ref: refs/heads/alias\n").unwrap();
        assert_eq!(git_symbolic_ref(&s(&det)).unwrap_or_default().trim(), "vlad/T20261127-04");
        assert!(!head_cannot_be_vlad_with(&s(&det), false));
        let _ = std::fs::remove_file(det.join(".git/refs/heads/alias"));
        std::os::unix::fs::symlink("vlad/T20261127-05", det.join(".git/refs/heads/alias")).unwrap();
        assert!(!head_cannot_be_vlad_with(&s(&det), false)); // symlink ref: git'e bırak
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn user_homedir_resolves() {
        assert!(user_homedir().unwrap().starts_with('/'));
    }

    #[test]
    fn realpath_nul_none() {
        assert_eq!(realpath("/tmp\0x"), None);
        assert!(realpath("/").is_some());
    }
}
