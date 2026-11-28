//! Saf veri tipleri ve eşik değerlendirmesi (sistem çağrısı yok; birim testli).
use serde::{Deserialize, Serialize};

pub const GIB: u64 = 1024 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Ok,
    Warn,
    Critical,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Ok => "ok",
            Level::Warn => "warn",
            Level::Critical => "critical",
        }
    }
}

/// `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical (memory_pressure ile aynı kaynak).
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Pressure {
    Normal,
    Warn,
    Critical,
    Unknown,
}

impl Pressure {
    pub fn from_raw(v: u32) -> Pressure {
        match v {
            1 => Pressure::Normal,
            2 => Pressure::Warn,
            4 => Pressure::Critical,
            _ => Pressure::Unknown,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Pressure::Normal => "normal",
            Pressure::Warn => "warn",
            Pressure::Critical => "critical",
            Pressure::Unknown => "unknown",
        }
    }
}

/// Sistem geneli örnek. `free_pct` = `kern.memorystatus_level` (memory_pressure'ın "System-wide memory free percentage"ı).
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
pub struct SystemStats {
    pub total_bytes: u64,
    pub free_pct: u32,
    pub pressure: Pressure,
    pub swap_total_bytes: u64,
    pub swap_used_bytes: u64,
}

/// Halka tampondaki sıkı örnek (1 saat × 10 sn = 360 nokta).
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
pub struct HistPoint {
    pub ts: u64,
    pub free_pct: u32,
    pub pressure: Pressure,
    pub swap_used_bytes: u64,
    pub vlad_bytes: u64,
}

#[derive(Clone, Copy, Debug)]
pub struct Thresholds {
    pub warn_free_pct: u32,
    pub crit_free_pct: u32,
    pub swap_growth_bytes: u64,
    pub swap_growth_window_secs: u64,
}

impl Default for Thresholds {
    fn default() -> Self {
        Thresholds {
            warn_free_pct: 20,
            crit_free_pct: 10,
            swap_growth_bytes: GIB,
            swap_growth_window_secs: 300,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Verdict {
    pub level: Level,
    pub reasons: Vec<String>,
}

pub fn fmt_bytes(b: u64) -> String {
    let g = b as f64 / GIB as f64;
    if g >= 1.0 {
        format!("{g:.1} GiB")
    } else {
        format!("{:.0} MiB", b as f64 / (1024.0 * 1024.0))
    }
}

/// Eşik kuralı (görev T20261128-06): warn = baskı warn ya da boş < %20; critical = baskı critical, boş < %10
/// ya da swap'ın pencere içindeki en düşük değerinden bu yana `swap_growth_bytes` kadar artması.
pub fn evaluate(sys: &SystemStats, history: &[HistPoint], now: u64, th: &Thresholds) -> Verdict {
    let mut crit = Vec::new();
    let mut warn = Vec::new();
    match sys.pressure {
        Pressure::Critical => crit.push("sistem baskısı critical".to_string()),
        Pressure::Warn => warn.push("sistem baskısı warn".to_string()),
        _ => {}
    }
    if sys.free_pct < th.crit_free_pct {
        crit.push(format!("boş %{} < %{}", sys.free_pct, th.crit_free_pct));
    } else if sys.free_pct < th.warn_free_pct {
        warn.push(format!("boş %{} < %{}", sys.free_pct, th.warn_free_pct));
    }
    let since = now.saturating_sub(th.swap_growth_window_secs);
    if let Some(min) = history
        .iter()
        .filter(|p| p.ts >= since && p.ts <= now)
        .map(|p| p.swap_used_bytes)
        .min()
    {
        let grew = sys.swap_used_bytes.saturating_sub(min);
        if grew >= th.swap_growth_bytes {
            crit.push(format!(
                "swap {} dk'da +{}",
                th.swap_growth_window_secs / 60,
                fmt_bytes(grew)
            ));
        }
    }
    if !crit.is_empty() {
        crit.extend(warn);
        Verdict {
            level: Level::Critical,
            reasons: crit,
        }
    } else if !warn.is_empty() {
        Verdict {
            level: Level::Warn,
            reasons: warn,
        }
    } else {
        Verdict {
            level: Level::Ok,
            reasons: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sys(free: u32, p: Pressure, swap: u64) -> SystemStats {
        SystemStats {
            total_bytes: 16 * GIB,
            free_pct: free,
            pressure: p,
            swap_total_bytes: 2 * GIB,
            swap_used_bytes: swap,
        }
    }
    fn pt(ts: u64, swap: u64) -> HistPoint {
        HistPoint {
            ts,
            free_pct: 50,
            pressure: Pressure::Normal,
            swap_used_bytes: swap,
            vlad_bytes: 0,
        }
    }
    const TH: Thresholds = Thresholds {
        warn_free_pct: 20,
        crit_free_pct: 10,
        swap_growth_bytes: GIB,
        swap_growth_window_secs: 300,
    };

    #[test]
    fn pressure_raw_mapping_matches_memory_pressure() {
        assert_eq!(Pressure::from_raw(1), Pressure::Normal);
        assert_eq!(Pressure::from_raw(2), Pressure::Warn);
        assert_eq!(Pressure::from_raw(4), Pressure::Critical);
        assert_eq!(Pressure::from_raw(0), Pressure::Unknown);
    }

    #[test]
    fn healthy_is_ok() {
        let v = evaluate(&sys(60, Pressure::Normal, GIB), &[], 1000, &TH);
        assert_eq!(v.level, Level::Ok);
        assert!(v.reasons.is_empty());
    }

    #[test]
    fn free_below_20_is_warn_and_exactly_20_is_ok() {
        assert_eq!(
            evaluate(&sys(19, Pressure::Normal, 0), &[], 0, &TH).level,
            Level::Warn
        );
        assert_eq!(
            evaluate(&sys(20, Pressure::Normal, 0), &[], 0, &TH).level,
            Level::Ok
        );
    }

    #[test]
    fn pressure_warn_is_warn() {
        let v = evaluate(&sys(50, Pressure::Warn, 0), &[], 0, &TH);
        assert_eq!(v.level, Level::Warn);
        assert_eq!(v.reasons, vec!["sistem baskısı warn".to_string()]);
    }

    #[test]
    fn free_below_10_is_critical_and_exactly_10_is_warn() {
        let v = evaluate(&sys(9, Pressure::Normal, 0), &[], 0, &TH);
        assert_eq!(v.level, Level::Critical);
        assert_eq!(v.reasons, vec!["boş %9 < %10".to_string()]);
        assert_eq!(
            evaluate(&sys(10, Pressure::Normal, 0), &[], 0, &TH).level,
            Level::Warn
        );
    }

    #[test]
    fn pressure_critical_is_critical_and_keeps_warn_reasons() {
        let v = evaluate(&sys(15, Pressure::Critical, 0), &[], 0, &TH);
        assert_eq!(v.level, Level::Critical);
        assert_eq!(
            v.reasons,
            vec![
                "sistem baskısı critical".to_string(),
                "boş %15 < %20".to_string()
            ]
        );
    }

    #[test]
    fn swap_growth_within_window_is_critical() {
        let h = [pt(1000, GIB), pt(1100, GIB + GIB / 2), pt(1200, 2 * GIB)];
        let v = evaluate(&sys(50, Pressure::Normal, 2 * GIB), &h, 1250, &TH);
        assert_eq!(v.level, Level::Critical);
        assert_eq!(v.reasons, vec!["swap 5 dk'da +1.0 GiB".to_string()]);
    }

    #[test]
    fn swap_growth_outside_window_is_ignored() {
        // en düşük nokta pencerenin (now-300) dışında: yavaş artış alarm değildir
        let h = [pt(600, 0), pt(1000, GIB / 2)];
        let v = evaluate(&sys(50, Pressure::Normal, GIB + GIB / 4), &h, 1250, &TH);
        assert_eq!(v.level, Level::Ok);
    }

    #[test]
    fn swap_shrinking_is_ok() {
        let h = [pt(1000, 2 * GIB)];
        assert_eq!(
            evaluate(&sys(50, Pressure::Normal, 0), &h, 1100, &TH).level,
            Level::Ok
        );
    }

    #[test]
    fn fmt_bytes_units() {
        assert_eq!(fmt_bytes(512 * 1024 * 1024), "512 MiB");
        assert_eq!(fmt_bytes(3 * GIB / 2), "1.5 GiB");
    }
}
