//! memwatch — VLAD bellek bekçisi (T20261128-06).
//!   memwatch top [--json] [--once] [--interval <sn>]   canlı tablo (2 sn) ya da tek atımlık JSON
//!   memwatch check [--json] [--state <yol>]             tek ölçüm + seviye (vlad task launch kapısı)
//!   memwatch daemon [--state <yol>] [--channel <yol>] [--interval <sn>] [--once]
//! Durum dosyası varsayılanı `~/.vlad-monitor/memwatch.json`; ntfy kanalı `~/.vlad-secret/approver/channel.json`.
mod alert;
mod daemon;
mod model;
mod ntfy;
mod report;
mod state;
mod sys;
mod tree;

use model::{HistPoint, Thresholds};
use report::Snapshot;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Durum dosyası bu kadar saniyeden eskiyse geçmişi (swap artışı için) kullanılmaz.
const FRESH_SECS: u64 = 120;

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn tmux_panes() -> Vec<(String, i32)> {
    for bin in ["tmux", "/opt/homebrew/bin/tmux", "/usr/local/bin/tmux"] {
        let out = Command::new(bin)
            .args(["list-panes", "-a", "-F", "#{session_name} #{pane_pid}"])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output();
        match out {
            Ok(o) if o.status.success() => {
                return tree::parse_tmux_panes(&String::from_utf8_lossy(&o.stdout))
            }
            Ok(_) => return Vec::new(), // tmux var ama sunucu yok
            Err(_) => continue,         // bu yolda tmux yok
        }
    }
    Vec::new()
}

fn sample(history: &[HistPoint], th: &Thresholds) -> Result<Snapshot, String> {
    let system = sys::system().map_err(|e| format!("bellek ölçülemedi: {e}"))?;
    let groups = tree::group(&sys::procs(), &tmux_panes());
    Ok(report::build(now(), system, groups, history, th))
}

fn fresh_history(path: Option<&Path>) -> Vec<HistPoint> {
    path.and_then(state::load)
        .filter(|s| now().saturating_sub(s.updated) <= FRESH_SECS)
        .map(|s| s.history)
        .unwrap_or_default()
}

struct Args {
    flags: Vec<String>,
    values: Vec<(String, String)>,
}

fn parse(rest: &[String], value_flags: &[&str], bool_flags: &[&str]) -> Result<Args, String> {
    let mut a = Args {
        flags: Vec::new(),
        values: Vec::new(),
    };
    let mut it = rest.iter();
    while let Some(x) = it.next() {
        if value_flags.contains(&x.as_str()) {
            let v = it.next().ok_or(format!("{x} değer ister"))?;
            a.values.push((x.clone(), v.clone()));
        } else if bool_flags.contains(&x.as_str()) {
            a.flags.push(x.clone());
        } else {
            return Err(format!("bilinmeyen argüman: {x}"));
        }
    }
    Ok(a)
}

impl Args {
    fn has(&self, f: &str) -> bool {
        self.flags.iter().any(|x| x == f)
    }
    fn get(&self, f: &str) -> Option<&str> {
        self.values
            .iter()
            .rev()
            .find(|(k, _)| k == f)
            .map(|(_, v)| v.as_str())
    }
    fn secs(&self, f: &str, def: u64) -> Result<u64, String> {
        match self.get(f) {
            None => Ok(def),
            Some(v) => v
                .parse::<u64>()
                .ok()
                .filter(|n| (1..=3600).contains(n))
                .ok_or(format!("{f} 1..3600 sn olmalı")),
        }
    }
    fn path(&self, f: &str, def: Option<PathBuf>) -> Option<PathBuf> {
        self.get(f).map(PathBuf::from).or(def)
    }
}

fn default_state() -> Option<PathBuf> {
    state::default_dir().map(|d| d.join(state::STATE_NAME))
}

fn cmd_top(a: Args) -> Result<(), String> {
    let th = Thresholds::default();
    let st = a.path("--state", default_state());
    if a.has("--json") {
        let s = sample(&fresh_history(st.as_deref()), &th)?;
        println!(
            "{}",
            serde_json::to_string_pretty(&s).map_err(|e| e.to_string())?
        );
        return Ok(());
    }
    let every = Duration::from_secs(a.secs("--interval", 2)?);
    loop {
        let s = sample(&fresh_history(st.as_deref()), &th)?;
        if a.has("--once") {
            print!("{}", report::render_table(&s));
            return Ok(());
        }
        println!("\x1b[H\x1b[2J{}(çıkış: Ctrl-C)", report::render_table(&s));
        std::thread::sleep(every);
    }
}

fn cmd_check(a: Args) -> Result<(), String> {
    let st = a.path("--state", default_state());
    let s = sample(&fresh_history(st.as_deref()), &Thresholds::default())?;
    if a.has("--json") {
        println!("{}", serde_json::to_string(&s).map_err(|e| e.to_string())?);
    } else {
        println!("{}", report::summary(&s));
    }
    Ok(())
}

fn cmd_daemon(a: Args) -> Result<(), String> {
    let st = a
        .path("--state", default_state())
        .ok_or("durum dosyası yolu çözülemedi (HOME yok)")?;
    let chan = a.path("--channel", ntfy::default_channel_path());
    let interval = a.secs("--interval", 10)?;
    let mut d = daemon::Daemon::default();
    if let Some(prev) = state::load(&st) {
        // yeniden başlatmada bastırma ve (taze ise) geçmiş korunur
        d.alerts = prev.alerts;
        if now().saturating_sub(prev.updated) <= FRESH_SECS {
            d.history = prev.history;
        }
    }
    loop {
        let system = match sys::system() {
            Ok(s) => s,
            Err(e) if !a.has("--once") => {
                // geçici sysctl hatası daemon'u düşürmesin
                eprintln!("{} bellek ölçülemedi: {e}", now());
                std::thread::sleep(Duration::from_secs(interval));
                continue;
            }
            Err(e) => return Err(format!("bellek ölçülemedi: {e}")),
        };
        let groups = tree::group(&sys::procs(), &tmux_panes());
        let ts = now();
        let mut notify = |title: &str, msg: &str, critical: bool| -> Result<(), String> {
            match chan.as_deref().map(ntfy::read_channel) {
                None | Some(Ok(None)) => Err("ntfy kanalı kurulu değil".into()),
                Some(Err(e)) => Err(e),
                Some(Ok(Some(ch))) => ntfy::send(&ch, title, msg, critical),
            }
        };
        let (snap, sent) = d.step(ts, system, groups, &mut notify);
        match &sent {
            daemon::Outcome::Sent(l) => eprintln!(
                "{ts} uyarı gönderildi: {} — {}",
                l.as_str(),
                report::summary(&snap)
            ),
            daemon::Outcome::Failed(e) => {
                eprintln!("{ts} uyarı gönderilemedi ({e}): {}", report::summary(&snap))
            }
            daemon::Outcome::Quiet => {}
        }
        let file = state::StateFile {
            v: 1,
            updated: ts,
            pid: std::process::id(),
            interval_secs: interval,
            rss_bytes: sys::self_rss(),
            last: snap,
            history: d.history.clone(),
            alerts: d.alerts.clone(),
        };
        if let Err(e) = state::save(&st, &file) {
            eprintln!("{ts} durum dosyası yazılamadı: {e}");
        }
        if a.has("--once") {
            return Ok(());
        }
        std::thread::sleep(Duration::from_secs(interval));
    }
}

const USAGE: &str = "kullanım: memwatch top [--json] [--once] [--interval <sn>] [--state <yol>]\n       memwatch check [--json] [--state <yol>]\n       memwatch daemon [--state <yol>] [--channel <yol>] [--interval <sn>] [--once]";

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let Some((cmd, rest)) = argv.split_first() else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    let r = match cmd.as_str() {
        "top" => parse(rest, &["--interval", "--state"], &["--json", "--once"]).and_then(cmd_top),
        "check" => parse(rest, &["--state"], &["--json"]).and_then(cmd_check),
        "daemon" => {
            parse(rest, &["--state", "--channel", "--interval"], &["--once"]).and_then(cmd_daemon)
        }
        "--version" | "-V" => {
            println!("memwatch {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        "--help" | "-h" | "help" => {
            println!("{USAGE}");
            Ok(())
        }
        _ => Err(format!("bilinmeyen komut: {cmd}\n{USAGE}")),
    };
    match r {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("memwatch: {e}");
            ExitCode::from(1)
        }
    }
}
