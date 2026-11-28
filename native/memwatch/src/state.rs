//! Durum dosyası `~/.vlad-monitor/memwatch.json`: son örnek + 1 saatlik halka tampon + uyarı belleği.
//! Yazım atomik (tmp + rename), dizin 0700, dosya 0600. vlad TS tarafı (`src/memwatch/`) aynı şemayı okur.
use crate::alert::AlertMemo;
use crate::model::HistPoint;
use crate::report::Snapshot;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

pub const HISTORY_CAP: usize = 360;
pub const STATE_NAME: &str = "memwatch.json";

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct StateFile {
    pub v: u32,
    /// son yazım (unix sn); okuyan taraf tazeliği buna göre ölçer
    pub updated: u64,
    pub pid: u32,
    pub interval_secs: u64,
    /// daemon'un kendi RSS'i (bayt)
    pub rss_bytes: u64,
    pub last: Snapshot,
    pub history: Vec<HistPoint>,
    #[serde(default)]
    pub alerts: AlertMemo,
}

pub fn default_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .map(|h| PathBuf::from(h).join(".vlad-monitor"))
}

pub fn push_history(h: &mut Vec<HistPoint>, p: HistPoint) {
    h.push(p);
    if h.len() > HISTORY_CAP {
        let drop = h.len() - HISTORY_CAP;
        h.drain(..drop);
    }
}

/// Yok, bozuk ya da yabancı sürüm → None (daemon sıfırdan başlar; dosya üzerine yazılır).
pub fn load(path: &Path) -> Option<StateFile> {
    let raw = fs::read(path).ok()?;
    if raw.len() > 4 * 1024 * 1024 {
        return None;
    }
    let s: StateFile = serde_json::from_slice(&raw).ok()?;
    (s.v == 1).then_some(s)
}

pub fn save(path: &Path, s: &StateFile) -> io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::other("durum dosyasının dizini yok"))?;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    let tmp = dir.join(format!(".{}.{}.tmp", STATE_NAME, std::process::id()));
    let body = serde_json::to_vec(s).map_err(io::Error::other)?;
    let res = (|| {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(&body)?;
        f.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Pressure, SystemStats, Thresholds, GIB};
    use crate::report::build;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("memwatch-test-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }
    fn st(ts: u64) -> StateFile {
        let sys = SystemStats {
            total_bytes: 16 * GIB,
            free_pct: 50,
            pressure: Pressure::Normal,
            swap_total_bytes: 0,
            swap_used_bytes: 0,
        };
        StateFile {
            v: 1,
            updated: ts,
            pid: 1,
            interval_secs: 10,
            rss_bytes: 0,
            last: build(ts, sys, vec![], &[], &Thresholds::default()),
            history: vec![],
            alerts: AlertMemo::default(),
        }
    }

    #[test]
    fn ring_buffer_keeps_last_360() {
        let mut h = Vec::new();
        for i in 0..400 {
            push_history(
                &mut h,
                HistPoint {
                    ts: i,
                    free_pct: 1,
                    pressure: Pressure::Normal,
                    swap_used_bytes: 0,
                    vlad_bytes: 0,
                },
            );
        }
        assert_eq!(h.len(), HISTORY_CAP);
        assert_eq!(h[0].ts, 40);
        assert_eq!(h.last().unwrap().ts, 399);
    }

    #[test]
    fn save_then_load_roundtrip_with_private_modes() {
        let d = tmpdir("rt");
        let p = d.join("sub").join(STATE_NAME);
        save(&p, &st(7)).unwrap();
        assert_eq!(load(&p), Some(st(7)));
        assert_eq!(
            fs::metadata(&p).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(p.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        let leftovers: Vec<_> = fs::read_dir(p.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn corrupt_or_foreign_version_loads_none() {
        let d = tmpdir("bad");
        fs::create_dir_all(&d).unwrap();
        let p = d.join(STATE_NAME);
        fs::write(&p, b"{bozuk").unwrap();
        assert_eq!(load(&p), None);
        let mut s = serde_json::to_value(st(1)).unwrap();
        s["v"] = 2.into();
        fs::write(&p, s.to_string()).unwrap();
        assert_eq!(load(&p), None);
        assert_eq!(load(&d.join("yok.json")), None);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn save_failure_leaves_no_tmp() {
        let d = tmpdir("fail");
        fs::create_dir_all(&d).unwrap();
        // hedef bir dizin: rename başarısız olur
        let p = d.join(STATE_NAME);
        fs::create_dir_all(p.join("dolu")).unwrap();
        assert!(save(&p, &st(1)).is_err());
        let tmps = fs::read_dir(&d)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(tmps, 0);
        fs::remove_dir_all(&d).unwrap();
    }
}
