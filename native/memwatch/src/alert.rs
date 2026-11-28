//! Uyarı tekrar bastırma: aynı ya da daha yüksek seviyede uyarı son 15 dk içinde gittiyse yenisi gönderilmez.
//! critical, önceki warn'u bastırmaz (yükselme hemen bildirilir); warn, yakın zamanda giden critical'den sonra susar.
use crate::model::Level;
use serde::{Deserialize, Serialize};

pub const SUPPRESS_SECS: u64 = 15 * 60;

#[derive(Serialize, Deserialize, Clone, Default, PartialEq, Debug)]
pub struct AlertMemo {
    /// Son gönderilen warn / critical zamanı (unix sn). Durum dosyasında saklanır: daemon yeniden başlasa da bastırma sürer.
    #[serde(default)]
    pub warn: Option<u64>,
    #[serde(default)]
    pub critical: Option<u64>,
    /// Başarısız gönderimden sonra bu zamana kadar yeniden denenmez (ntfy kapalıyken 10 sn'de bir curl açmasın).
    #[serde(default)]
    pub retry_at: Option<u64>,
}

pub const RETRY_SECS: u64 = 60;

fn recent(at: Option<u64>, now: u64) -> bool {
    // saat pencere içinde geri giderse (at > now) yakın sayılır: kuşkuda tekrar gönderme. Damga pencereden de
    // ilerideyse (saat bir ara çok ileri atlamış) geçersizdir: yoksa düzeltilen saatle uyarılar uzun süre susardı.
    at.is_some_and(|t| {
        t <= now.saturating_add(SUPPRESS_SECS) && now.saturating_sub(t) < SUPPRESS_SECS
    })
}

impl AlertMemo {
    pub fn should_send(&self, level: Level, now: u64) -> bool {
        if self
            .retry_at
            .is_some_and(|t| now < t && t <= now.saturating_add(RETRY_SECS))
        {
            return false;
        }
        match level {
            Level::Ok => false,
            Level::Warn => !recent(self.warn, now) && !recent(self.critical, now),
            Level::Critical => !recent(self.critical, now),
        }
    }
    /// Başarısız gönderim: bastırmayı başlatmaz, yalnız RETRY_SECS boyunca yeniden denemeyi erteler.
    pub fn record_failure(&mut self, now: u64) {
        self.retry_at = Some(now + RETRY_SECS);
    }
    /// Yalnız gönderim başarılı olduktan sonra çağrılır.
    pub fn record(&mut self, level: Level, now: u64) {
        self.retry_at = None;
        match level {
            Level::Ok => {}
            Level::Warn => self.warn = Some(now),
            Level::Critical => self.critical = Some(now),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ok_never_sends() {
        assert!(!AlertMemo::default().should_send(Level::Ok, 0));
    }

    #[test]
    fn first_warn_sends_then_suppressed_for_15_min() {
        let mut m = AlertMemo::default();
        assert!(m.should_send(Level::Warn, 1000));
        m.record(Level::Warn, 1000);
        assert!(!m.should_send(Level::Warn, 1000 + SUPPRESS_SECS - 1));
        assert!(m.should_send(Level::Warn, 1000 + SUPPRESS_SECS));
    }

    #[test]
    fn critical_not_suppressed_by_recent_warn() {
        let mut m = AlertMemo::default();
        m.record(Level::Warn, 1000);
        assert!(m.should_send(Level::Critical, 1010));
    }

    #[test]
    fn warn_suppressed_by_recent_critical() {
        let mut m = AlertMemo::default();
        m.record(Level::Critical, 1000);
        assert!(!m.should_send(Level::Warn, 1100));
        assert!(!m.should_send(Level::Critical, 1100));
        assert!(m.should_send(Level::Warn, 1000 + SUPPRESS_SECS));
    }

    #[test]
    fn clock_going_backwards_suppresses() {
        let mut m = AlertMemo::default();
        m.record(Level::Critical, 5000);
        assert!(!m.should_send(Level::Critical, 4500));
    }

    #[test]
    fn far_future_stamp_from_a_wrong_clock_is_ignored() {
        // saat bir kez çok ileri atlayıp düzeltildi: kaydedilmiş damga pencereden de ileride → geçersiz, uyarı susmaz
        let mut m = AlertMemo::default();
        m.record(Level::Critical, 1_000_000);
        m.record_failure(1_000_000);
        assert!(m.should_send(Level::Critical, 1_000_000 - SUPPRESS_SECS - 1));
        // pencere içindeki küçük geri gidiş hâlâ bastırır
        assert!(!m.should_send(Level::Critical, 1_000_000 - SUPPRESS_SECS + 1));
    }

    #[test]
    fn unsent_alert_does_not_start_suppression() {
        let m = AlertMemo::default();
        assert!(m.should_send(Level::Critical, 1000));
        // record çağrılmadı (gönderim başarısız) → sonraki örnekte yeniden denenir
        assert!(m.should_send(Level::Critical, 1010));
    }

    #[test]
    fn failed_send_backs_off_for_a_minute() {
        let mut m = AlertMemo::default();
        m.record_failure(1000);
        assert!(!m.should_send(Level::Critical, 1000 + RETRY_SECS - 1));
        assert!(m.should_send(Level::Critical, 1000 + RETRY_SECS));
        m.record(Level::Critical, 1000 + RETRY_SECS);
        assert_eq!(m.retry_at, None);
    }
}
