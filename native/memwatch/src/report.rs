//! Tek atımlık örnek (`top --json`, `check --json`, durum dosyasındaki `last`) ve terminal tablosu.
use crate::model::{evaluate, fmt_bytes, HistPoint, Level, SystemStats, Thresholds};
use crate::tree::{Group, Kind};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Snapshot {
    pub ts: u64,
    pub level: Level,
    pub reasons: Vec<String>,
    pub system: SystemStats,
    /// tmux `vlad` + `vlad-*` oturumlarının footprint toplamı
    pub vlad_bytes: u64,
    pub groups: Vec<Group>,
}

pub fn build(
    ts: u64,
    system: SystemStats,
    groups: Vec<Group>,
    history: &[HistPoint],
    th: &Thresholds,
) -> Snapshot {
    let v = evaluate(&system, history, ts, th);
    let vlad_bytes = groups
        .iter()
        .filter(|g| matches!(g.kind, Kind::Task | Kind::Vlad))
        .map(|g| g.footprint_bytes)
        .sum();
    Snapshot {
        ts,
        level: v.level,
        reasons: v.reasons,
        system,
        vlad_bytes,
        groups,
    }
}

impl Snapshot {
    pub fn point(&self) -> HistPoint {
        HistPoint {
            ts: self.ts,
            free_pct: self.system.free_pct,
            pressure: self.system.pressure,
            swap_used_bytes: self.system.swap_used_bytes,
            vlad_bytes: self.vlad_bytes,
        }
    }
}

/// Tek satırlık özet: bildirim gövdesi ve `vlad task launch` iletisi.
pub fn summary(s: &Snapshot) -> String {
    let why = if s.reasons.is_empty() {
        String::new()
    } else {
        format!(" ({})", s.reasons.join("; "))
    };
    format!(
        "{}{}: boş %{}, baskı {}, swap {}/{}, vlad {}",
        s.level.as_str(),
        why,
        s.system.free_pct,
        s.system.pressure.as_str(),
        fmt_bytes(s.system.swap_used_bytes),
        fmt_bytes(s.system.swap_total_bytes),
        fmt_bytes(s.vlad_bytes)
    )
}

pub fn render_table(s: &Snapshot) -> String {
    let mut o = String::new();
    o.push_str(&format!(
        "memwatch  bellek {}  boş %{}  baskı {}  swap {}/{}  seviye {}\n",
        fmt_bytes(s.system.total_bytes),
        s.system.free_pct,
        s.system.pressure.as_str(),
        fmt_bytes(s.system.swap_used_bytes),
        fmt_bytes(s.system.swap_total_bytes),
        s.level.as_str().to_uppercase()
    ));
    if !s.reasons.is_empty() {
        o.push_str(&format!("  neden: {}\n", s.reasons.join("; ")));
    }
    o.push('\n');
    o.push_str(&format!(
        "{:<20} {:>10} {:>6}  {}\n",
        "SATIR", "FOOTPRINT", "SÜREÇ", "EN BÜYÜK"
    ));
    for g in &s.groups {
        let top = g
            .top
            .as_ref()
            .map(|t| {
                format!(
                    "{} ({}, pid {})",
                    t.name,
                    fmt_bytes(t.footprint_bytes),
                    t.pid
                )
            })
            .unwrap_or_else(|| "-".into());
        o.push_str(&format!(
            "{:<20} {:>10} {:>6}  {}\n",
            g.id,
            fmt_bytes(g.footprint_bytes),
            g.procs,
            top
        ));
    }
    if s.groups.is_empty() {
        o.push_str("(vlad tmux oturumu yok)\n");
    }
    o.push_str(&format!("\nvlad toplam {}\n", fmt_bytes(s.vlad_bytes)));
    o
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Pressure, GIB};
    use crate::tree::TopProc;

    fn sys(free: u32) -> SystemStats {
        SystemStats {
            total_bytes: 16 * GIB,
            free_pct: free,
            pressure: Pressure::Normal,
            swap_total_bytes: 2 * GIB,
            swap_used_bytes: GIB,
        }
    }
    fn g(id: &str, kind: Kind, b: u64) -> Group {
        Group {
            id: id.into(),
            kind,
            footprint_bytes: b,
            procs: 1,
            top: Some(TopProc {
                pid: 1,
                name: "claude".into(),
                footprint_bytes: b,
            }),
        }
    }

    #[test]
    fn vlad_bytes_counts_tasks_and_main_but_not_vm_or_terminal() {
        let s = build(
            10,
            sys(50),
            vec![
                g("T1", Kind::Task, GIB),
                g("vlad", Kind::Vlad, GIB),
                g("vm", Kind::Vm, 4 * GIB),
                g("terminal", Kind::Terminal, GIB),
            ],
            &[],
            &Thresholds::default(),
        );
        assert_eq!(s.vlad_bytes, 2 * GIB);
        assert_eq!(s.level, Level::Ok);
    }

    #[test]
    fn summary_names_level_and_reasons() {
        let s = build(10, sys(8), vec![], &[], &Thresholds::default());
        assert_eq!(
            summary(&s),
            "critical (boş %8 < %10): boş %8, baskı normal, swap 1.0 GiB/2.0 GiB, vlad 0 MiB"
        );
    }

    #[test]
    fn json_shape_is_stable() {
        let s = build(
            10,
            sys(50),
            vec![g("T1", Kind::Task, GIB)],
            &[],
            &Thresholds::default(),
        );
        let v: serde_json::Value = serde_json::to_value(&s).unwrap();
        assert_eq!(v["level"], "ok");
        assert_eq!(v["system"]["pressure"], "normal");
        assert_eq!(v["groups"][0]["kind"], "task");
        assert_eq!(v["groups"][0]["top"]["name"], "claude");
    }

    #[test]
    fn table_lists_rows() {
        let t = render_table(&build(
            10,
            sys(50),
            vec![g("T1", Kind::Task, GIB)],
            &[],
            &Thresholds::default(),
        ));
        assert!(t.contains("T1"));
        assert!(t.contains("claude (1.0 GiB, pid 1)"));
    }
}
