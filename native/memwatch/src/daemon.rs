//! Daemon adımı (saf çekirdek; ölçüm ve gönderim enjekte edilir): örnekten snapshot üretir, halka tampona ekler,
//! eşik aşıldıysa ve bastırılmıyorsa bildirir. Ana döngü `main.rs`'te (10 sn'de bir).
use crate::alert::AlertMemo;
use crate::model::{HistPoint, Level, SystemStats, Thresholds};
use crate::report::{build, summary, Snapshot};
use crate::state::push_history;
use crate::tree::Group;

pub type Notify<'a> = dyn FnMut(&str, &str, bool) -> Result<(), String> + 'a;

#[derive(Default)]
pub struct Daemon {
    pub history: Vec<HistPoint>,
    pub alerts: AlertMemo,
    pub th: Thresholds,
}

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Quiet,
    Sent(Level),
    Failed(String),
}

impl Daemon {
    pub fn step(
        &mut self,
        ts: u64,
        sys: SystemStats,
        groups: Vec<Group>,
        notify: &mut Notify,
    ) -> (Snapshot, Outcome) {
        let snap = build(ts, sys, groups, &self.history, &self.th);
        push_history(&mut self.history, snap.point());
        let mut sent = Outcome::Quiet;
        if self.alerts.should_send(snap.level, ts) {
            let critical = snap.level == Level::Critical;
            let title = if critical {
                "VLAD bellek KRİTİK"
            } else {
                "VLAD bellek uyarısı"
            };
            match notify(title, &summary(&snap), critical) {
                Ok(()) => {
                    self.alerts.record(snap.level, ts);
                    sent = Outcome::Sent(snap.level);
                }
                Err(e) => {
                    self.alerts.record_failure(ts);
                    sent = Outcome::Failed(e);
                }
            }
        }
        (snap, sent)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::alert::{RETRY_SECS, SUPPRESS_SECS};
    use crate::model::{Pressure, GIB};
    use crate::ntfy::{fake, send, Channel};
    use std::time::Duration;

    fn sys(free: u32) -> SystemStats {
        SystemStats {
            total_bytes: 16 * GIB,
            free_pct: free,
            pressure: Pressure::Normal,
            swap_total_bytes: 2 * GIB,
            swap_used_bytes: 0,
        }
    }

    #[test]
    fn healthy_steps_never_notify_and_fill_history() {
        let mut d = Daemon::default();
        let mut calls = 0;
        for i in 0..5 {
            let (s, sent) = d.step(i * 10, sys(60), vec![], &mut |_, _, _| {
                calls += 1;
                Ok(())
            });
            assert_eq!((s.level, sent), (Level::Ok, Outcome::Quiet));
        }
        assert_eq!(calls, 0);
        assert_eq!(d.history.len(), 5);
    }

    #[test]
    fn warn_repeats_suppressed_for_15_minutes_then_sent_again() {
        let mut d = Daemon::default();
        let mut sent = Vec::new();
        let mut ts = 0;
        while ts <= SUPPRESS_SECS + 10 {
            let (_, r) = d.step(ts, sys(15), vec![], &mut |t, _, c| {
                sent.push((t.to_string(), c));
                Ok(())
            });
            let _ = r;
            ts += 10;
        }
        assert_eq!(sent.len(), 2, "ilk örnek + 15 dk sonra");
        assert_eq!(sent[0], ("VLAD bellek uyarısı".to_string(), false));
    }

    #[test]
    fn escalation_to_critical_is_sent_immediately() {
        let mut d = Daemon::default();
        let mut levels = Vec::new();
        for (ts, free) in [(0, 15), (10, 15), (20, 5), (30, 5)] {
            if let (_, Outcome::Sent(l)) = d.step(ts, sys(free), vec![], &mut |_, _, _| Ok(())) {
                levels.push(l);
            }
        }
        assert_eq!(levels, vec![Level::Warn, Level::Critical]);
    }

    #[test]
    fn failed_send_retries_after_backoff_not_every_tick() {
        let mut d = Daemon::default();
        let mut tries = 0;
        let mut ts = 0;
        while ts < RETRY_SECS * 2 {
            d.step(ts, sys(5), vec![], &mut |_, _, _| {
                tries += 1;
                Err("ağ".into())
            });
            ts += 10;
        }
        assert_eq!(tries, 2, "0. sn ve 60. sn");
    }

    #[test]
    fn swap_growth_from_history_triggers_critical() {
        let mut d = Daemon::default();
        let mut s = sys(60);
        d.step(0, s, vec![], &mut |_, _, _| Ok(()));
        s.swap_used_bytes = GIB + 1;
        let (snap, sent) = d.step(10, s, vec![], &mut |_, _, _| Ok(()));
        assert_eq!(snap.level, Level::Critical);
        assert_eq!(sent, Outcome::Sent(Level::Critical));
    }

    #[test]
    fn critical_alert_reaches_fake_ntfy_server() {
        let (addr, rx) = fake::serve(200, 1);
        let ch = Channel {
            origin: addr,
            topic: "vlad-q-test".into(),
        };
        let mut d = Daemon::default();
        let (_, sent) = d.step(100, sys(5), vec![], &mut |t, m, c| send(&ch, t, m, c));
        assert_eq!(sent, Outcome::Sent(Level::Critical));
        let got = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&got.body).unwrap();
        assert_eq!(v["title"], "VLAD bellek KRİTİK");
        assert!(v["message"]
            .as_str()
            .unwrap()
            .starts_with("critical (boş %5 < %10)"));
    }
}
