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
    match rx.recv_timeout(timeout) {
        Ok(Ok(buf)) => {
            // stdout kapandı: süreç sonlanıyor; çıkış durumunu kalan sürede bekle
            let status = child.wait().ok()?;
            if !status.success() {
                return None;
            }
            Some(String::from_utf8_lossy(&buf).into_owned())
        }
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            None
        }
    }
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
