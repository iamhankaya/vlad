---
slug: medialog
name: medialog
path: C:\dev\medialog
repo: iamhankaya/medialog
default_branch: main
exposure: internet
stack: []
status: active
autonomy: commit
last_activity: 2026-10-22T11:10:49+03:00
last_scanned: null
---

## Özet
Anime, dizi, film ve kitap verilerini dış kaynaklardan çeken kişisel takip sitesi. Özellikler:
- kayıt/giriş, izleme/okuma listeleri, sezon/bölüm ilerlemesi (ör. "Suits 2. sezon 15. bölüm");
- arkadaşlık ve arkadaşlar arası gerçek zamanlı sohbet;
- v2: arkadaş akışı, takvim, bildirimler, e-posta özeti, içe aktarma (Letterboxd/MAL/Goodreads/CSV), istatistik, etiketler, moderasyon.

## Mimari notlar
- Exposure: internet (kullanıcı onayı 2026-10-20). Repo: private `iamhankaya/medialog`, ana branch `main`.
- Yığın:
  - Node/TypeScript monorepo (`apps/server`, `apps/web`, `packages/shared`);
  - Postgres; WebSocket;
  - Docker compose + Caddy; dağıtım GitHub Actions'tan SSH ile (`deploy.yml` `check`/`deploy`/`rollback`).
- DB rolleri:
  - `medialog`: önyükleme süper kullanıcısı.
  - `medialog_owner`: sahip; migration'ları tek seferlik `migrate` servisi bu rolle çalıştırır.
  - `medialog_app`: çalışma rolü; ne süper kullanıcı ne sahip. `mod_actions` üzerinde yalnız SELECT/INSERT yetkisi var.
- Testler:
  - birim (`npm test`);
  - kabul (`tests/`, harness önekleri);
  - güvenlik (`tests/security`);
  - a11y/Chromium (`tests/a11y`).
  - Test DB için `scripts/test-db.sh`; koşmadan önce `node_modules/.vitest-cache` silinmeli.
- Canlı ortam (karar 2026-10-21): Oracle Always Free ARM VM + DuckDNS `medialogforfriends.duckdns.org` + Gmail SMTP (`MAIL_TRANSPORT=smtp`). Adımlar `deploy/RUNBOOK.md` §1–2'de.

## Son aktivite
- 2026-10-22: CI yalnız main PR/push + elle tetikleme, concurrency, docs/md atlama (Actions dakikası); PR #69. (T20261022-54)
- 2026-10-22: Manga devam eden seride "Bölüm N / 128+" biçimi; PR #68, deploy 39741056149. (T20261022-53)
- 2026-10-22: Liste "Bölüm N / ?" kökü düzeltildi + ertelenen 6 görsel bulgu; PR #67, deploy 39734935211. (T20261022-52)
- 2026-10-22: Dağıtım: backup.sh compose kipinde pg_restore düzeltmesi; manga dağıtımı ön yedekten geçti. (T20261022-51)
- 2026-10-22: **Manga/manhwa/manhua canlıda** (MangaUpdates; PR #65, deploy 39727634523); kullanıcı canlı aramayı doğruladı. Denetim 25 bulgu (2 yüksek) düzeltme turunda kapandı. (görev T20261021-89)
- 2026-10-21: Takvim kullanıcıda doğrulandı; ilk `airing_refresh` turundan sonra doldu, hata yok.
- 2026-10-21: **Canlıya alındı**: https://medialogforfriends.duckdns.org (deploy run 7, ef3eb0c). Üç dağıtım hatası düzeltildi (PR #58–#60). (T20261020-58, T20261021-86..88)
- 2026-10-21: v2 `main`'e merge edildi (PR #57, e438e19). (görev T20261020-84)
- 2026-10-21: Güvenlik denetimleri ve SEC2/SEC3 düzeltmeleri tamamlandı; açık kritik/yüksek/orta yok. (T20261021-79, -82, -81, -84)
- 2026-10-20: v1 `main`'e merge edildi (PR #24). (görev T20261020-58)

## Açık konular
- **Açık bulgu:** F-medialog-001 (orta) canlı gece yedeği (cron) doğrulanmadı; dış hedef (rclone) yok. Diğer manga bulguları kullanıcı kararıyla kapandı (2026-10-22).
- **Backlog — dış yedek:** gece yedeği (03:17) Google Drive'a rclone ile kopyalansın (`BACKUP_RCLONE_*`, RUNBOOK §1.8). (kullanıcı 2026-10-21)
- **Canlı ortam bilgileri:**
  - Oracle VM 144.21.41.159, IP rezerve değil (ephemeral; VM silinmedikçe değişmez).
  - Dağıtım anahtarı Cloud Shell'de `~/medialog_deploy` (ECDSA).
  - Yönetici yetkisi: `jobs-cli grant-admin`, RUNBOOK §6a.
- **Canlıda doğrulanacak:** IPv6/AAAA durumu (SEC3-08'in önemini etkiler).
- **Arayüz metni eksik (SEC-08/SEC3-03):** çekişmeli hesapta doğrulamadan sonra parola sıfırlamayla belirleniyor, ama arayüz bunu anlatmıyor.
- **SEC-08 (v1):** yeniden kayıtta kullanıcı adı ilk kayıttaki kalıyor; ürün kararı gerekiyor.
- **TMDB logosu:** kullanım koşulu doğrulanmadı; şimdilik yalnız metin atfı var.
- **Askı süresi:** değiştirme ya da erken kaldırma arayüzü yok (CLI `unsuspend`); v2.1 adayı.
