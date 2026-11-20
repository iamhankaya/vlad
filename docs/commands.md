# VLAD komut başvurusu

<!-- Üretilmiştir: `npm run build && npm run docs:commands`. Elle düzenleme; açıklamalar src/commands/docs-data.ts, politika src/commands/manifest.ts. -->

Bayrakların tamamı için `vlad <komut> --help`. Her satırın sonunda manifest politikası: işçi makinede davranışı, vlad-desktop konsol kataloğu, `--json` desteği. Makine okunur çıktı için `--json` ekle; hata olursa CLI stderr'e `{"error": ..., "details": [...]}` basar ve 1 ile çıkar.

## scan

- `vlad scan` — Kök klasörlerdeki repoları tarar, proje kartlarını oluşturur/günceller. _(yerel; konsol: okuma; --json)_

## project

- `vlad project write` — Proje kartını yazar. Kartın isteğe bağlı `skills` listesi (projenin `.claude/skills` adları) buradan yazılır, launch prompt'unda adıyla geçer ve `audit skills`'te beklenir. Sonrasında kartın koddan üretilen blokları kendiliğinden tazelenir. _(işçide reddedilir; konsol: yazma; --json)_
- `vlad project set` — Kart alanını yazar: exposure, repo, default_branch, local_only, local_only_reason, `machines`, `gate` (projenin tek kapı komutu). Değeri `-` ile başlayan alan için `--` kullan: `project set <slug> gate -- "- a"`. _(işçide reddedilir; konsol: yazma; --json)_
- `vlad project note` — `project note <slug> "<ders>"`: kartın `## Çalışma notları` bölümüne tarihli madde ekler (bu bölümü yalnız bu komut yazar). _(işçide reddedilir; konsol: yazma; --json)_
- `vlad project status` — `project status <slug>`: durum özeti (kart özeti anlatısı + koddan üretilen sayılar, aktif görevler, açık bulgular, geçerli kararların sonu). _(yerel; konsol: okuma; --json)_
- `vlad project summary` — `project summary <slug> --file <md>`: kartın `## Durum özeti` bölümünü yazar; `/digest` günceller. _(işçide reddedilir; konsol: yazma; --json)_
- `vlad project refresh` — `project refresh <slug>|--all`: kartın koddan üretilen bloklarını (açık bulgular, Son aktivite) yeniden üretir, blok dışı metne dokunmaz. Bloksuz `## Son aktivite`'e ilk açık refresh bloğunu bölümün başına ekler, elle satırlar altında kalır; kancalar Son aktivite bloğu yoksa yazmaz. `project write`, `finding add|set` ve `task set <id> done` sonrası ilgili blok kendiliğinden tazelenir. _(işçide reddedilir; konsol: yazma; --json)_
- `vlad project list` — Proje kartlarını listeler (`--json`: `gate`, `machines` vb. alanlar). _(yerel; konsol: okuma; --json)_

## finding

- `vlad finding add` — Bulgu kaydı açar (`kb/findings/<id>.md`, `F-<proje>-NNN`; önem: kritik|yüksek|orta|düşük|bilgi). Kartı olmayan projeyi reddeder; aynı projede başlığı benzer açık bulgu varsa `warnings: [{similar}]` ile uyarır (yine oluşturur). _(işçide reddedilir; konsol: yazma; --json)_
- `vlad finding list` — Bulguları listeler. Ek süzgeçler: `--older-than <gün>`, `--source <görev>`. _(yerel; konsol: okuma; --json)_
- `vlad finding set` — `finding set <id...> <durum> [--reason "<metin>"] [--by <görev>]`: çoklu ID, hepsi-ya-hiç (durum: open|deferred|fixed|wontfix). `wontfix`'te `--reason` zorunlu; gerekçe bulgu dosyasının `## Kapanış` bölümüne yazılır. _(işçide reddedilir; konsol: yazma; --json)_

## idea

- `vlad idea add` — `idea add --project <slug> --title "<t>" [--detail-file] [--source <id>]`: fikir kaydı açar (`kb/ideas/I-<proje>-NNN.md`); fikirler bulgu değildir, kartın açık bulgu bloğuna girmez. _(işçide reddedilir; konsol: yazma; --json)_
- `vlad idea list` — `idea list [--project] [--state open|promoted|dropped] --json`: fikirleri listeler. _(yerel; konsol: okuma; --json)_
- `vlad idea set` — `idea set <id...> dropped --reason "<metin>"`: fikri bırakır (gerekçe zorunlu, hepsi-ya-hiç). _(işçide reddedilir; konsol: yazma; --json)_
- `vlad idea promote` — `idea promote <id> --task <T-id>`: fikri göreve bağlar (state promoted). _(işçide reddedilir; konsol: yazma; --json)_
- `vlad idea from-finding` — `idea from-finding <F-id...>`: bulguları fikre taşır; bulgu `wontfix` ("fikir deposuna taşındı: I-…") olur, hepsi-ya-hiç. _(işçide reddedilir; konsol: yazma; --json)_

## role

- `vlad role list` — Uzman rolleri listeler (`roles/`). _(yerel; konsol: okuma; --json)_

## task

- `vlad task new` — queued görev oluşturur (pipeline için `--kind pipeline`, faz için `--parent`, `--depends-on`, `--phase`, `--role`; `--model`: Opus için `--model-reason` zorunlu). Pipeline iskeleti tek komutta: `--pipeline --cycle tam|özellik|kısa [--ui] [--prova] [--skip <faz> --skip-reason <r>] [--phase-body <faz>=<dosya>] [--phase-model <faz>=<model>[:<gerekçe>]]` (opus için gerekçe zorunlu) çatı + döngü fazlarını hepsi-ya-hiç oluşturur. _(işçide reddedilir; konsol: yazma; --json)_
- `vlad task launch` — Worktree + branch açar, `running` yapar, Launcher'ı çağırır (güven kaydı dahil). `--external`: terminal AÇMAZ, betik yazar ve JSON'da `script`, `command`, `cwd` döner; bulut modunda reddedilir. _(işçide reddedilir; konsol: yazma; --json)_
- `vlad task release` — `task release <id> [--force]`: belirsiz uzak launch rezervasyonunu (ve çatı makine pin'ini) bırakır; işçi launch'ı görmediyse iptal işareti yazılır; ölü makinedeki rezervasyon için de kullanılır. `--force` işçi ulaşılamazken kullanılır; yetim pencere riski var. _(işçide reddedilir; konsolda yok; --json)_
- `vlad task repin` — `task repin <çatı-id> <makine> [--force] [--json]`: pipeline çatısının makine pin'ini başka makineye taşır (yalnız `pipeline`; hedef config'te ve kartın `machines` listesinde olmalı; eski makinede running faz varsa `--force` ister). `warnings`: entegrasyon dalı hedefte olmayabilir. İlerlemeye `Repin: <eski> → <yeni>` yazılır. _(işçide reddedilir; konsolda yok; --json)_
- `vlad task ingest` — Bulut çalışanının `list_events` çıktısındaki `[VLAD:*]` işaretlerini (`LOG`/`ASK`/`REPORT`/`FAIL`) görev dosyasına işler (idempotent). _(işçide reddedilir; konsol: yazma; --json)_
- `vlad task log` — `task log <id> "<metin>"`: `## İlerleme`'ye satır ekler. İşçide beyne iletilir. Metin `İzin reddi`/`reddetti`/`denied` içeriyorsa stderr'e `task deny` uyarısı verir (kayıt yine yazılır). _(beyne iletilir; konsol: yazma; --json)_
- `vlad task deny` — `task deny <id> --tool <araç> --pattern "<komut>" [--reason]`: çalışanın izin reddini kaydeder (`## İlerleme`'ye `[İZİN]` satırı + `kb/logs/denials.jsonl`); `audit setup` tekrarlayanları izin kuralı adayı olarak listeler. _(beyne iletilir; konsol: yazma; --json)_
- `vlad task ask` — `task ask <id> "<soru>"`: `## Sorular`'a soru yazar, görev `blocked` olur. İşçide beyne iletilir. _(beyne iletilir; konsol: yazma; --json)_
- `vlad task answer` — `task answer <id> "<cevap>"`: soruya `**Cevap:**` yazar; blocked görevi running'e alır. Rapor açık soruyla yazılıp awaiting_approval'a geçmiş görevde (cevapsız soru varsa) yalnız Cevap yazar, durum awaiting_approval kalır (F-vlad-341). _(işçide reddedilir; konsol: yazma; --json)_
- `vlad task report` — `task report <id> --file <md>`: kapanış raporunu yazar, görev `awaiting_approval` olur. Rapordaki `### Kapatılan bulgular` satırlarında kısaltılmış/bilinmeyen/kapalı ID için uyarır. İşçide beyne iletilir. _(beyne iletilir; konsol: yazma; --json)_
- `vlad task set` — `task set <id> <durum>`: durumu değiştirir (geçersiz geçiş reddedilir). `cancelled` için `--reason "<metin>"` zorunlu (gerekçesiz hata verir); `## İlerleme`'ye `İptal: <metin>` yazılır. `done` sonrası ilgili kart bloğu tazelenir; `done` çıktısı kartın durum özeti bayatsa (ya da yoksa) `summaryStale: true` ve `warnings` verir (özet güncelse `false`, kart okunamazsa alan yok). _(işçide reddedilir; konsol: yazma; --json)_
- `vlad task deps` — `task deps <id>`: queued pipeline fazının bağımlılıklarını değiştirir (tam olarak bir mod). _(işçide reddedilir; konsol: yazma; --json)_
- `vlad task resume` — Kesilen (`running`/`stalled`) çalışanı sürdürür. `--external`: aynı alanlarla devam prompt'lu betik; kayıtlı `session_id` varsa `claude --resume <id>`, yoksa worktree'deki tek transcript, o da yoksa taze oturum (`--continue` kullanılmaz); `--model` korunur. Durumu değiştirmez (`stalled` ise önce `task set <id> running`); açık pencereyi kapatmaz, çift çalışan olmasın diye önce `close-window`. _(işçide reddedilir; konsol: yazma; --json)_
- `vlad task close-window` — Görevin çalışan penceresini/süreç ağacını kapatır; durum ve worktree'ye dokunmaz. _(yerel; konsol: yazma; --json)_
- `vlad task nudge` — Yerel çalışanın tmux penceresine (`vlad-<id>`) tek satır metin yazar ve Enter'ı istem kutusu boşalana kadar (en çok 5) tekrarlar; meşgul çalışanda Enter yutulunca metin kutuda kalmasın diye (F-vlad-361). Metin bir kez yazılır. Teslim edilemezse çıkış 1 (SendMessage'a düş). Yalnız macOS/Linux tmux; uzak makinede yok. _(işçide reddedilir; konsolda yok; --json)_
- `vlad task cleanup` — `task cleanup <id>`: done/cancelled görevin çalışan penceresini kapatır ve worktree'sini kaldırır. _(işçide reddedilir; konsol: yazma; --json)_
- `vlad task gate` — `task gate <id> [--target integration|task] [--compare-base]`: kapı komutunu koşar. Varsayılan hedef görev türüne göre: pipeline çatısı → integration, dev görevi → task. `--compare-base` (uzak görev): hedef dalın aynı makinedeki taban sonucuyla karşılaştırır, yalnız tabanda yeşil olup görevde kırmızı olanları `newRed` sayar (F-vlad-290). _(işçide reddedilir; konsol: yazma; --json)_
- `vlad task merge-preview` — Merge'ün ön izlemesi (çakışma/diff), salt okuma. _(işçide reddedilir; konsol: okuma; --json)_
- `vlad task merge` — Uzak (işçideki) görevde merge (`--no-ff`); push etmez, çakışmada işçi geri alır. Yalnız açık onaydan sonra. Uzak görevin dalını beyne getirmez: o iş için `task close` (işçide `branch-push` → beyinde fetch + merge) kullanılır. _(işçide reddedilir; konsol: yazma; --json)_
- `vlad task close` — `task close <id> [--into <dal>] [--yes] [--head <sha>] [--all-machines] [--skip-machine <ad,...> --reason "<onay metni>"] --json`: kapıyı tek komutta yürütür (ön kontrol, gate, merge-tree, `merge --no-ff`, `done`, `cleanup`, `### Kapatılan bulgular` → `finding set fixed --by`, `kb commit --push`). `--yes` yoksa merge öncesi durur ve özet basar; açık gece modu + yeşil gate + açık P1 yoksa sormadan sürer. Kırmızı gate, çakışma, kirli ağaç ya da eksik kanıtta durur; `steps`/`stopped_at` verir, çıkış 1. done görevde yeniden koşu kalanı (cleanup, bulgu, kb) tamamlar. **Uzak makinedeki tek görev / çatı kökü** (D-vlad-076): gate işçide koşar, ardından (onay `--yes`/gece modu verildiyse; onaysız çağrı gate'ten sonra `confirm`'de durur, dal origin'e GİTMEZ) `push` adımında işçi Agent'ının `branch-push` op'u yalnız gate'lenen sha'yı `vlad/<id>` olarak origin'e iter (force yok, başka dal/etiket yok; günlüğe `branch-push: …` satırı düşer), `fetch` adımında beyin `git fetch origin vlad/<id>` ile alır (FETCH_HEAD = gate'lenen sha), çakışma önizlemesi ve merge beyinde sha ile yapılır; push/fetch hatasında `stopped_at: push|fetch`, merge yok; yeniden koşu idempotent (origin'de zaten varsa push atlanır). Uzak pipeline fazı eskisi gibi işçide merge edilir; done uzak görevde kayıtlı yeşil head hedef dalda değilse precheck durur. İşçide origin ve etkileşimsiz git push kimliği önkoşuldur (`docs/machines-setup.md`). Gate'lenen commit'e bağlıdır: confirm durağı head'i basar, `--head <sha>` onaylanan head'i taşır; dal ucu gate'ten sonra değiştiyse ya da `--head` farklıysa merge etmez. Gece modu pipeline çatısını (son kapı) ve `designer` rolünü kapsamaz, onlar gece de `--yes` ister; çatı kapanış raporu istemez, çok projeli çatıda durur. Kart `machines` ≥2 ise son kapıda (pipeline) ya da `--all-machines` ile her makine için `Gate <makine>: yeşil <sha>` satırı zorunlu, aksi halde uyarı. **Onaylı makine atlaması (F-vlad-339):** erişilemeyen makine (ör. Windows) için kullanıcı açıkça onayladıysa `--skip-machine <ad,...> --reason "<kullanıcının onay metni>"` o makinenin yeşil gate satırı aramasını atlar; `--reason` boşsa, makine kartta yoksa, gate'i koşan makineyse ya da `--all-machines` ile birlikte verilirse precheck durur; bayraklar çalışan oturumuna kapalıdır (`VLAD_TASK_ID`/çalışan worktree'si: reddedilir); atlama her koşuda açıkça verilmelidir (geçmiş kayıt atlama sayılmaz) ve görev günlüğüne `Gate <makine>: ATLANDI @ <sha> — kullanıcı onayı: <metin>` yazılır, uyarıya düşer (elle merge gerekmez). _(işçide reddedilir; konsolda yok; --json)_
- `vlad task digested` — Görevin kapanış raporunun `/digest` tarafından işlendiğini işaretler. _(işçide reddedilir; konsol: yazma; --json)_
- `vlad task session` — Görevin Claude `session_id`'sini kaydeder. İşçide beyne iletilir. _(beyne iletilir; konsol: yazma; --json)_
- `vlad task list` — Görevleri listeler. `list --json --fields id,state,title --limit 20` yavaş tam çıktı yerine kısa çıktı verir (`effective_model` kısa kümede de var; `role_model` yalnız `--fields` ya da tam çıktıda). _(yerel; konsol: okuma; --json)_
- `vlad task idle` — Uzun süredir güncellenmeyen running/blocked görevler (bekçi modu dürtmesi için). _(yerel; konsol: okuma; --json)_
- `vlad task ready` — `task ready --parent <id>`: başlatılabilir fazları verir (`maxParallel` doluysa fazlar `held_by_limit`'te döner). _(yerel; konsol: okuma; --json)_

## status

- `vlad status` — `vlad status [--summary] [--no-mark]`: aktif görevler. `--summary` digest edilmemiş `done` görev varsa "N done görev digest edilmedi (en eski: <tarih>)" ekler; JSON'da `undigested` ve `oldestUndigested`. `--no-mark`: yan etkisiz okuma — stalled işaretlemez, mod penceresini temizlemez; aynı JSON şekli. `--summary` satırı "N kb çelişkisi" ekler ve JSON'da `kbLint: {count, byCode, at}` verir — son tam `vlad kb lint` koşusunun önbelleği `kb/logs/kb-lint.json`, `summary_stale` sayılmaz, SessionStart hook'u önbellek 6 saatten eskiyse ya da kb HEAD değiştiyse `kb lint`'i 10 sn zaman aşımıyla koşup önbelleği tazeler (işçide/kimliği belirsiz makinede koşmaz; tazelenemezse eski diye gösterir). _(yerel; konsol: okuma; --json)_

## mode

- `vlad mode night` — Gece/yetki modunu açar (pencere `kb/mode.json`'da). _(işçide reddedilir; konsol: yazma; --json)_
- `vlad mode watch` — Bekçi modunu açar. _(işçide reddedilir; konsol: yazma; --json)_
- `vlad mode off` — Modu kapatır. _(işçide reddedilir; konsol: yazma; --json)_
- `vlad mode token` — VLAD oturumu için imzalı mod belirteci üretir (`export VLAD_MODE_TOKEN=$(vlad mode token)`; `--ttl <saat>`, varsayılan 24, en çok 72). Yalnız etkileşimli terminalde (TTY) çalışır; ilk çalıştırmada anahtarı gizli dizinde (`~/.vlad-secret`, passwd ev dizini; ortam değişkeniyle değiştirilemez; 0700/0600; `--reset` bozuk/düşürülmüş anahtarı yeniden üretir; `--disable` mekanizmayı tamamen kapatır: gizli dizin + dışındaki etkinleştirme işareti silinir; ikisi de geçerli VLAD_MODE_TOKEN ister, anahtar yok/bozuksa elle SIFIRLA onayı) üretir. Etkinleştirme işareti anahtar dizininin dışındadır: dizin silinip `mode.json`'dan imza çıkarılsa bile (düşürme, F-vlad-336) korunan işlemler fail-closed reddedilir ve `vlad status` "düşürülmüş" uyarısı verir. Anahtar etkinken `mode night|watch|off`, `setup` ve `install` (`--check`/`--dry-run` hariç) geçerli `VLAD_MODE_TOKEN` ister; çalışan başlatma betikleri belirteci temizler. Tasarım: `docs/superpowers/specs/2026-11-13-vlad-mode-token-design.md`. _(işçide reddedilir; konsolda yok; --json)_
- `vlad mode request` — `mode request [--wait [--wait-seconds <n>]] [--json] <komut> [argümanlar...]`: herhangi bir vlad komutu (manifestteki her yol; ör. `monitor install`, `task set …`; eski kısa adlar `night|watch|off`) için telefondan onay ister (yalnız VLAD; çalışan reddedilir; `VLAD_MODE_TOKEN` istemez, anahtarı okumaz). İstek approver servisine yazılır, kullanıcı telefondan onaylayınca servis komutu tek kullanımlık yetkiyle kendisi çalıştırır (yalnız `node <cli> <argv>`). `console: none` komutlar (`mode request|token`, `approver run|install|…`, `task close`…), `remote` ve `agent *` istenemez (izin kümesi: `mode night|watch|off`, `install`, `setup`, `monitor install|uninstall`; VMT2 yalnız bu kümeye verilir); argv ntfy'ye düz gider, sır geçirmeyin; bildirimde tam argv görünür; her çalıştırma `approver.log`/sonuç kaydına (isteyen, argv, onay zamanı, çıkış kodu) yazılır. Bayraklar işlemden önce verilir. `--wait` varsayılanı 310 sn (sonuç yoksa çıkış 1, `wait_timeout`; istek iptal edilmez). Hata sırası: çalışan → geçersiz argüman → approver kurulu değil → servis (kilitli/meşgul/hız sınırı) → yanıt yok. Tasarım ve güvenlik sınırı (aynı-UID kapsam dışı): `docs/uzaktan-onay.md`. _(işçide reddedilir; konsolda yok; --json)_
- `vlad mode status` — Mod durumunu gösterir. _(işçide reddedilir; konsol: okuma; --json)_

## approver

- `vlad approver install` — `approver install [--server <url>]`: uzaktan onay servisini kurar (`channel.json` + launchd plist `com.vlad.approver`); gizli abonelik URL'sini yalnız stdout TTY ise basar. Terminalde, mod yetkisiyle (`VLAD_MODE_TOKEN`); çalışan reddedilir; yalnız macOS. _(işçide reddedilir; konsolda yok; --json)_
- `vlad approver uninstall` — `approver uninstall`: servisi durdurur, plist'i ve `approver/` altını siler; `used/` ve `mode.key`'e dokunmaz. Terminalde, mod yetkisiyle. _(işçide reddedilir; konsolda yok; --json)_
- `vlad approver rotate` — `approver rotate`: yeni gizli istek konusu üretir, bekleyen isteği reddeder (`denied: rotated`), yeni abonelik URL'sini TTY'ye basar; eski konu etkisiz kalır. Terminalde, mod yetkisiyle. _(işçide reddedilir; konsolda yok; --json)_
- `vlad approver unlock` — `approver unlock`: 3 art arda ret/süre dolumunun açtığı 1 saatlik kilidi açar. Terminalde, mod yetkisiyle; çalışan reddedilir. _(işçide reddedilir; konsolda yok; --json)_
- `vlad approver run` — Servis girişi (launchd girişi): bekleyen istekleri izler, telefona bildirir, onayı tüketir ve işlemi çalıştırır. Gelen port açmaz. Elle çalıştırılmaz. _(işçide reddedilir; konsolda yok; --json)_
- `vlad approver status` — `approver status [--json]`: servis durumu (kurulu/çalışıyor, bekleyen istek, kilit). Salt okuma; konu/nonce/tag göstermez. _(işçide reddedilir; konsol: okuma; --json)_
- `vlad approver requests` — `approver requests [--json] [--limit N]`: son istekler ve sonuçları. Salt okuma; sır içermez. _(işçide reddedilir; konsol: okuma; --json)_
- `vlad approver show` — `approver show <id>`: tek isteğin ayrıntısı (işlem, argümanlar, isteyen, durum). Salt okuma. _(işçide reddedilir; konsol: okuma; --json)_

## monitor

- `vlad monitor pull` — `monitor pull [--server <ad>] [--dry-run] [--json]`: yapılandırmadaki spc ajanlarından `/spc/v1/alerts`'i imleçle çeker (belirteç macOS Keychain'den). Yalnız `severity: critical` + `firing` alarm için eşlenen projede bir `research` görevi açar (queued; sunucu başına çekişte en çok 5); `warning`/`info` yalnız log. İdempotans anahtarı `(server, alert_id)` (durum dosyası `~/.vlad-monitor/` + görev gövdesindeki `spc-alert:` işareti). `resolved` gelince açık görevin `## İlerleme`'sine not düşer, görevi kapatmaz. Şema sürümü uyuşmazsa açık hata. Çıkış: 0 tamam, 1 sunucu/şema hatası, 2 yapılandırma/altyapı. kb'ye commit etmez. Yalnız macOS beyin makinede. _(işçide reddedilir; konsol: yazma; --json)_
- `vlad monitor capacity` — `monitor capacity [--server <ad>] [--dry-run] [--force] [--json]`: haftalık kapasite raporu (launchd `com.vlad.monitor-capacity`, pazartesi 09:00). `monitor.servers[].capacity_file` (spc `capacity.yaml`) tetikleyicileri için `/spc/v1/since`'ten 30 günlük 1 dk özetini çeker, günlük zirve/eğilim hesaplar; sunucu başına tek kalıcı `[spc] kapasite raporu` görevinin günlüğüne tablo ekler; bir tetikleyici eşiğin %70'ini geçince (`warn`) ya da aştığında (`over`) tetikleyici başına en çok bir açık `architect` research görevi açar (gövde işareti `spc-capacity:`; seçenekler açık uçludur, karar kullanıcıda, kod yok) ve bildirim düşer; iki ardışık hafta `over` ise günlüğe TETİKLEYİCİ notu. ISO hafta idempotanslı (`--force` yeniden yazar), `--dry-run` hiçbir şey yazmaz. `capacity_file` yoksa sunucu atlanır (`--server` ile istenirse hata). Çıkış: 0 tamam, 1 sunucu/şema hatası, 2 yapılandırma/altyapı. kb'ye commit etmez. Yalnız macOS beyin makinede. _(işçide reddedilir; konsol: yazma; --json)_
- `vlad monitor status` — `monitor status [--json]`: sunucu başına imleç, son başarı, ardışık hata (3 ve üstü 'erişilemez ×N'), açık alarm→görev eşlemeleri ve launchd durumu. Salt okuma. _(yerel; konsol: okuma; --json)_
- `vlad monitor notices list` — `monitor notices list [--json]`: `monitor pull` görev açınca düşen okunmamış bildirimler (olay başına bir dosya, `~/.vlad-monitor/notify/`; kimlik/metaveri, alarm metni yok). Açık VLAD oturumu ve SessionStart özeti (`N monitor bildirimi`) bunu okur. kb'ye dokunmaz. _(yerel; konsol: okuma; --json)_
- `vlad monitor notices count` — `monitor notices count [--json]`: okunmamış bildirim sayısı (salt sayı; `Monitor` aracıyla ucuz yoklama için). kb'ye dokunmaz. _(yerel; konsol: okuma; --json)_
- `vlad monitor notices done` — `monitor notices done <id> | --all [--json]`: bildirimi okundu yapar (`notify/done/` altına taşır). Olmayan kimlik çıkış 1. kb'ye dokunmaz, kilit almaz. _(işçide reddedilir; konsol: yazma; --json)_
- `vlad monitor install` — `monitor install`: 5 dakikada bir `vlad monitor pull` çalıştıran launchd servisini (`com.vlad.monitor`) ve haftalık (pazartesi 09:00) `vlad monitor capacity` işini (`com.vlad.monitor-capacity`) kurar; ortamda sır yok, belirteç Keychain'den okunur. Terminalde, mod yetkisiyle; çalışan reddedilir; yalnız macOS. `vlad install` monitor yapılandırması varsa bunu da kurar. _(işçide reddedilir; konsolda yok; --json)_
- `vlad monitor uninstall` — `monitor uninstall`: monitor launchd servisini durdurur ve plist'ini siler (`~/.vlad-monitor/` durum dosyasına dokunmaz). Terminalde, mod yetkisiyle. _(işçide reddedilir; konsolda yok; --json)_

## audit

- `vlad audit skills` — `audit skills [--since] [--project]`: beklenen/yüklenen/eksik skill denetimi. _(yerel; konsol: okuma; --json)_
- `vlad audit setup` — `audit setup [--since] [--json]`: salt okuma; biten görev ölçümleri, açık noktalar, sürtünme işaretleri, skill envanteri, yaşlı bulgular. `/setup-audit` kullanır. _(işçide reddedilir; konsolda yok; --json)_

## inbox

- `vlad inbox list` — İşlenmemiş session raporlarını listeler. _(yerel; konsol: okuma; --json)_
- `vlad inbox count` — İşlenmemiş rapor sayısı. _(yerel; konsol: okuma; --json)_
- `vlad inbox done` — Raporu işlenmiş işaretler. _(işçide reddedilir; konsol: yazma; --json)_

## digest

Onay bekleyen digest maddeleri.

- `vlad digest pending add` — `add --text "<metin>" [--task <id>] [--project <slug>]`: onay bekleyen digest maddesi ekler (kalıcı liste `kb/digest-pending.json`; otomatik digest emin olmadığı maddeyi buraya ekler, `status --summary` sayıyı gösterir; D-vlad-061). _(işçide reddedilir; konsol: yazma; --json)_
- `vlad digest pending list` — `list [--all]`: onay bekleyen digest maddeleri. _(yerel; konsol: okuma; --json)_
- `vlad digest pending done` — `done <id> [--note "<metin>"]`: maddeyi kapatır. _(işçide reddedilir; konsol: yazma; --json)_

## decision

- `vlad decision add` — Karar ekler (`kb/decisions/<proje>.md`, `D-<proje>-NNN`, `Durum: geçerli`). `--supersedes <id>`; `--until <YYYY-MM-DD|YYYY-MM-DDTHH:MM>` süreli karar (kararda `Süre` satırı; süre geçince `project status`, `decision list` ve `kb lint` "süresi dolmuş geçerli karar" işaretler; tarih-yalnız o günün sonuna kadar). _(işçide reddedilir; konsol: yazma; --json)_
- `vlad decision list` — Yalnız **geçerli** kararları listeler; geçersiz/yerine geçilmişler `--all` ile. _(yerel; konsol: okuma; --json)_
- `vlad decision set` — `decision set <id> <durum> [--superseded-by <id>]`: durum geçerli|geçersiz|yerine-geçti. _(işçide reddedilir; konsol: yazma; --json)_
- `vlad decision migrate` — `migrate [--dry-run]`: ID'siz eski blokları numaralar (metin silinmez, idempotent). _(işçide reddedilir; konsol: yazma; --json)_

## journal

- `vlad journal append` — `journal append <tarih>`: `kb/journal/<tarih>.md`'ye ekler. _(işçide reddedilir; konsol: yazma; --json)_
- `vlad journal get` — `journal get <tarih> --json`: günlük içeriği + proje bölümleri, salt okuma. _(yerel; konsol: okuma; --json)_

## kb

- `vlad kb commit` — `kb commit "<özet>" [--push]`: kb reposunda commit'ler, upstream'e push eder. _(işçide reddedilir; konsol: yazma; --json)_
- `vlad kb maintain` — `kb maintain [--days 14] [--dry-run] --json`: biten görev/bulguları arşive taşır (silme yok); ayrıca eski tek dosyalı karar günlüğünü böler. _(işçide reddedilir; konsol: yazma; --json)_
- `vlad kb get` — `kb get <id> [--section "## Kapanış raporu"] --json`: kaydın gerçek yolu + içeriği (arşivdekini de bulur). _(yerel; konsol: okuma; --json)_
- `vlad kb search` — `kb search "<sorgu>" [--project] [--type] --json`: sınırlı arama (arşiv dahil). _(yerel; konsol: okuma; --json)_
- `vlad kb refs` — `kb refs <id> [--json]`: T…/F-…/D-… ID'ye atıf yapan kayıtlar (bölüm/durum/tarih), ilgili commit'ler ve çelişki işaretleri; salt okuma. _(yerel; konsol: okuma; --json)_
- `vlad kb lint` — `kb lint [--project] [--strict] [--json]`: kart/özet/karar/hafıza metinlerindeki ID atıflarını gerçek durumla karşılaştırır, salt okuma. Mac'te tüm kb <1 sn (Windows'ta daha yavaş olabilir); `--project`'siz koşu `status --summary` önbelleğini `kb/logs/kb-lint.json`'a yazar. Hafıza dizini config `memoryDirs`, yoksa `%USERPROFILE%\.claude\projects\<VLAD_HOME, harf/rakam dışı → ->\memory`; dizin yoksa sessizce atlanır. Kod tablosu: `docs/kb-lint.md`. _(işçide reddedilir; konsol: okuma; --json)_
- `vlad kb check` — kb reposunda yabancı commit/durum denetimi. _(yerel; konsol: okuma; --json)_

## session

- `vlad session register` — `session register <ad>`: VLAD session adını kaydeder (çalışan bildirimleri için). _(işçide reddedilir; konsol: yazma; --json)_
- `vlad session name` — Kayıtlı VLAD session adını verir. _(yerel; konsol: okuma; --json)_

## worktree

- `vlad worktree prune` — `worktree prune [--dry-run] [--yes] [--json]`: `<repo>-wt/` altında git'te kayıtlı olmayan, adı görev ID'si olan ve görevi done/cancelled olan, içinde yalnız `.remember` bulunan artık klasörleri listeler (başka içerik varsa 'içerik var, atlandı';kayıt `git worktree list --porcelain -z` ile literal yol karşılaştırmasıyla bulunur); varsayılan dry-run, silmek için `--yes`; `--dry-run` ile birlikte verilirse `--dry-run` kazanır (hiçbir şey silinmez). Kayıtlı worktree'ye, running/queued/bilinmeyen göreve ve sembolik bağlantıya dokunmaz; `git worktree list` okunamayan kökte hiçbir şey silmez. _(işçide reddedilir; konsolda yok; --json)_

## agent

Çoklu makine (T20261101-19): yerel Agent. Alt komutları ilgili fazlar ekler.

- `vlad agent start` — Yerel VLAD Agent'ı başlatır (tek TCP portu, HMAC imzalı). _(yerel; konsolda yok; --json)_
- `vlad agent status` — Yerel Agent durumu. _(yerel; konsolda yok; --json)_
- `vlad agent keygen` — `keygen <karşı-taraf>`: yalnız o iki makinenin bildiği **çift anahtar** üretir (D-vlad-057); anahtarı yalnız `--show` ile basar. Karşı uçta `setkey` çalıştırılır. _(yerel; konsolda yok; --json)_
- `vlad agent setkey` — `setkey <bu-makine> -`: anahtarı stdin'den alır. İşçi yalnız beyinle paylaştığı anahtarı tutar. _(yerel; konsolda yok; --json)_
- `vlad agent install` — Agent kaydını basar; `--apply` kurar. _(yerel; konsolda yok; --json)_

## queue

Çoklu makine: beyin erişilemezken yedek yazma kuyruğu.

- `vlad queue list` — Beyin erişilemezken yedek yazma kuyruğunu listeler. _(yerel; konsolda yok; --json)_
- `vlad queue flush` — Kuyruğu şimdi göndermeyi dener. _(yerel; konsolda yok; --json)_
- `vlad queue drop` — `queue drop <seq>`: başarısız girdiyi siler. _(yerel; konsolda yok; --json)_

## remote

Çoklu makine: konsoldan beyinde komut.

- `vlad remote` — `remote [--op-id] [--stdin] -- <argv>`: konsoldan beyinde komut çalıştırır. _(işçide reddedilir; konsolda yok)_

## machine

Çoklu makine: makine listesi, Agent ping, kayıtlı bakım betikleri.

- `vlad machine list` — Makine listesi (yerel kimlik işaretli). _(yerel; konsolda yok; --json)_
- `vlad machine ping` — Agent ping. _(yerel; konsolda yok; --json)_
- `vlad machine probe-window` — İşçide pencere denemesi. _(yerel; konsolda yok; --json)_
- `vlad machine scripts` — `machine scripts <ad>`: işçinin kayıtlı bakım betikleri ve bütünlük durumu; yalnız beyin. _(işçide reddedilir; konsolda yok; --json)_
- `vlad machine run` — `machine run <ad> <betik> [--param k=v] [--plan] [--confirmed <plan-id>] [--op-id <id>] [--json]`: kayıtlı bakım betiği. Write sınıfı için önce `--plan`, kullanıcının açık onayından sonra `--confirmed`; konsoldan çalıştırılamaz (T20261109-03: sözleşme T20261109-05). _(işçide reddedilir; konsolda yok; --json)_

## send

Aktarım (T20261105-03): Mac↔Windows ortak pano + dosya gönderme.

- `vlad send` — `send <yol...> [--to <makine>] [--json] [--notify]`: dosya/klasörü karşı makinenin İndirilenler'ine yollar; sağ tık menüsü `vlad install` ile gelir (T20261105-03). _(yerel; konsolda yok; --json)_

## clip

Aktarım (T20261105-03): ortak pano.

- `vlad clip on` — Ortak panoyu açar. _(yerel; konsolda yok; --json)_
- `vlad clip off` — Ortak panoyu kapatır. _(yerel; konsolda yok; --json)_
- `vlad clip status` — Ortak pano durumu. _(yerel; konsolda yok; --json)_
- `vlad clip get` — Panoyu okur; `--out <png>` görseli dosyaya yazar. _(yerel; konsolda yok; --json)_
- `vlad clip set` — `set [metin]|--file <yol|->|--image <png>`: panoya yazar. _(yerel; konsolda yok; --json)_

## install

- `vlad install` — Yerel kurulum (skill'ler, sağ tık menüsü vb.). _(yerel; konsolda yok; --json)_

## setup

- `vlad setup` — `setup [--answers <json|->] [--dry-run] [--yes] [--only <parça,...>] [--confirm <eylem,...>] [--json]`: kurulum sihirbazı (13 parça: tools, cli, kb, config, global-skills, repo-skills, hooks, permissions, plugins, agent, launcher, mac-main, memory); idempotent, JSON'a yapısal yazar + yedek; kişisel ayarlar `vlad.config.local.json` katmanına yazılır, tracked config'e dokunmaz. Repo oluşturma/keygen/Agent/LaunchAgent/izin ve plugin yazımı yalnız `--confirm` bayrağı ya da sihirbaz sorusuyla (`--answers` içindeki `confirm` reddedilir, `--yes` aşmaz). Linux'ta beyin kurulmaz. `--check [--json] [--strict] [--only]` salt okuma doktor (0 yeşil / 1 hata / 2 kullanım); `--upgrade` git pull sonrası eşitleme; `--uninstall <hooks|global-skills|config>`; `--join <beyin> [--brain-host --brain-port --brain-os] [--key-stdin]` işçi (anahtar yalnız `--key-stdin` ile stdin'den okunur; bayrak yoksa stdin okunmaz, anahtar yazılmaz ve bildirilir); `--add-worker <ad> [--host --os --port]` beyinde işçi ekler; cevapta `fresh: true` tracked kişisel değerleri nötrler. Kılavuz: README "Yeni makine / arkadaş kurulumu". _(yerel; konsolda yok; --json)_
