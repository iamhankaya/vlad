# VLAD: alarm → oturum haberi ve haftalık kapasite raporu: uygulama planı

> **Uygulayıcıya:** adımları sırayla izle; her görevde önce başarısız test, sonra kod, sonra test, sonra commit (TDD). Bu plan yalnız VLAD reposunu (`/Users/metehankaya/dev/vlad`) ve spc'de tek bir küçük dosya çiftini (Görev 1) kapsar. Kapsam: spec `2026-11-20-spc-panel-mobil-design.md` §6.4 madde 2 ve 3, §8 madde 1 ve 8. (6.4.1 `vlad monitor install` zaten yapıldı.)

**Hedef:** (a) `monitor pull` görev açınca telefona ntfy iletisi atar ve açık VLAD oturumunun okuyacağı kb dışı bir kuyruğa kayıt düşer; kayıt SessionStart özet satırında görünür. (b) Haftalık iş, ajanların 30 günlük 1 dk özetinden eşik eğilimini hesaplar, raporu görev günlüğüne yazar, bir tetikleyici %70'i geçince eşli projede tek bir açık uçlu `architect` research görevi açar.

**Kapsam dışı:** ajana yeni uç eklemek (bkz. Açık sorular), eşiğin kendisini değiştirmek (kaynak karar D-medialog-062 aynen), `monitor install`in kendisi (yalnız ikinci plist eklenir), ajan dağıtımı (`/release`), mobil/panel işleri.

**Mimari özet:** Yeni dosyalar `src/monitor/` altında, mevcut `types.ts`'e dokunmadan (paralel iş çakışmasın diye). Kb'ye yazma yalnız `createTask`/`logTask` ile (CLI ile aynı kod yolu), komut `lock: "outer"` alır, **commit etmez** (`monitor pull` gibi; VLAD sonra `vlad kb commit --push` yapar). Çalışanlar kb'ye dokunmaz; bu komutlar launchd'den VLAD'ın kendi makinesinde koşar.

## Karar 1: anında haber mekanizması (spec §8.1; "dosya mı, komut mu")

**Seçim: kuyruk = `~/.vlad-monitor/notify/` altında olay başına bir JSON dosyası; okuyucu = yeni `vlad monitor notices list|count|done` komutları; ntfy = onay kanalının mevcut ntfy bağlantısı.**

Gerekçe:
- launchd süreci Claude oturumuna mesaj atamaz (spec §8.1); tek köprü dosya sistemi. Oturumun okuması için bir komut gerekir (dosya biçimini oturumun bilmesi gerekmesin); ikisi birlikte: dosya taşıyıcı, komut okuyucu.
- **Olay başına dosya, tek dosyaya satır eklemekten iyi:** `pull` (5 dk) ve haftalık `capacity` ayrı süreçlerdir; aynı dosyaya eşzamanlı append yarışır. Dosya adı belirleyici (`<server>__<kind>__<id>.json`) olduğundan aynı olay iki kez yazılsa idempotenttir; yazma `tmp + rename` ile atomiktir; "okundu" = dosyayı `notify/done/` altına taşımak.
- Dizin `0700`, dosya `0600` (`~/.vlad-monitor` ile aynı kural). İçerik **yalnız kimlik/metaveri** (`v, ts, kind, server, task, trigger?`); ajan metni (alarm başlığı) **girmez** (ajan metni veridir, ortak güvenlik kuralı).
- **ntfy yeniden kullanımı:** `src/approver/ntfy.ts` `NtfyChannel` ve `approver/store.ts` `readChannel()` (`~/.vlad-secret/approver/channel.json`: sunucu + gizli konu) var. Yeni, onay düğmesiz `publishNotice({title, message})` yöntemi (öncelik 3, aynı konu → kullanıcı zaten abone). `ApproverChannel` arayüzüne **eklenmez** (mevcut sahte kanallar kırılmasın). Kanal kurulu değilse ya da ağ hatasında ntfy sessizce atlanır, `pull` başarısız olmaz (en iyi çaba; kuyruk dosyası asıl kayıt).
- **Oturum tarafı:** açık oturum `Monitor` aracıyla `vlad monitor notices count` döngüsünü izler (Görev 7'de CLAUDE.md'ye yazılır); oturum yoksa ntfy telefona gider ve bir sonraki SessionStart özeti satırı bildirimi gösterir.
- Reddedilen alternatif: `vlad notify` ile Claude oturumuna doğrudan itme. `vlad session register` adı yalnız Claude içinden `SendMessage` ile kullanılabilir; launchd'den çağıracak güvenilir yol yok.

## Karar 2: kapasite işinin nerede koşacağı (spec §7)

**Seçim: VLAD tarafında, yeni `vlad monitor capacity` komutu; ayrı bir launchd işi `com.vlad.monitor-capacity` (`StartCalendarInterval`: pazartesi 09:00, `RunAtLoad` yok). `vlad monitor install` ikisini birden kurar.**

Gerekçe:
- Kb yazımı (görev, günlük) yalnız `vlad` CLI/kodunda olabilir (spec §7); spc tarafında koşan bir iş kb'ye yazamaz. Eşli proje, belirteç (Keychain) ve istemci kodu zaten `src/monitor/*` içinde.
- Mevcut 5 dk'lık `monitor pull` servisine "haftalık mı?" mantığı eklemek iki ilgisiz işi bağlar (biri çökerse diğeri etkilenir, günlük karışır, `pull` süresi uzar). Ayrı plist ucuz: `monitorPlist` etiket/argüman/zamanlama alacak şekilde genelleştirilir.
- `StartCalendarInterval` Mac uykudayken kaçan çalıştırmayı uyanınca bir kez koşar. Yine de komut **ISO hafta anahtarlı idempotenttir** (aynı hafta tekrar çalışırsa yazma yok; `--force` yok sayar), yani elle çalıştırmak ve yeniden denemek güvenlidir.

## Karar 3: kapasite hesabı sözleşmesi

- **Veri:** ajan yalnız `/spc/v1/since?resolution=1m` verir (metrik süzgeci ve özet ucu yok). İstemci `from = now-30g` ile sayfalar (`limit=5000`), **yalnız `capacity.yaml`'daki metrik+etiket seçicilerine uyan öğeleri** akış hâlinde günlük (UTC) kovaya indirger (bellek: seri × 30 gün). Sayfa tavanı ve `unreachable`/`schema_mismatch` hataları `monitor pull` ile aynı sınıflandırma. Bkz. Açık sorular 1.
- **Ölçüler** (`measure`): `peak` (kovaların `max`'ının en büyüğü), `daily_avg_peak` (günlük n-ağırlıklı ortalamaların en büyüğü; "sürekli >%60" yaklaşığı). Birden çok seri eşleşirse seri başına hesaplanır, en büyüğü alınır.
- **Çıktılar (tetikleyici başına):** 7g zirve, 30g zirve, `pct = değer7g / eşik`, haftalık artış (son ≤4 hafta için haftalık değerlere en küçük kareler eğimi, birim/hafta), eşiğe kalan süre = `(eşik − değer7g) / eğim` hafta (eğim ≤ 0 → "artmıyor"; ≥ eşik → "aşıldı"; < 3 tam hafta → "yetersiz veri").
- **Tetikleyici durumu:** `pct ≥ 70` → `warn`; `pct ≥ 100` → `over`. **"2 ardışık hafta" = iki ardışık ISO haftasının raporunda `over`** (durum dosyası `~/.vlad-monitor/capacity.json`, tetikleyici başına son haftalar). Atlanan hafta (rapor yok) seriyi sıfırlar ve raporda "hafta atlandı" yazar (muhafazakâr; Açık sorular 3).
- **Rapor yeri:** sunucu başına tek, uzun ömürlü `research`/`analyst` görevi `[spc] kapasite raporu: <server>` (gövdede `spc-capacity-report: <server>` işareti; yoksa ilk koşuda açılır); her hafta `logTask` ile bir tablo eklenir. Açık `architect` görevi varsa aynı hafta verisi **onun günlüğüne de** eklenir (spec §8.8).
- **Architect görevi:** `warn` olan tetikleyici başına **en çok bir açık** görev (`kind: research`, `role: architect`, eşli proje); dedupe anahtarı işaret satırı `spc-capacity: <server>/<trigger_id>` (arşiv dahil gövde taraması, `monitor pull`daki `markerIndex` kalıbı) + durum dosyası. Açıkken yeni hafta yalnız günlüğe eklenir. Kapandıktan sonra yalnız `over` olunca yeniden açılır (Açık sorular 2). Gövde: eşik, kaynak karar ID'si, rapor tablosu; **"seçenekler açık uçludur; kullanıcının örnekleri (sunucu artırma, yük dengeleyici, okuma/yazma DB ayrımı) yalnız örnektir, başka seçenekler (önbellek, bağlantı havuzu/sorgu iyileştirme, ölçek sınırı yeniden değerlendirme, hiçbir şey yapmama) de değerlendirilir"**; çıktı: seçenek başına maliyet/risk/geri dönüş + öneri; karar kullanıcıda, kod yazılmaz.
- Görev açılınca/`over` olunca ntfy + notices kuyruğu (Karar 1 altyapısı, `kind: "capacity"`).

## Görevler

Bağımlılık: G1 ∥ G2 ∥ G4 (ayrık dosyalar) → G3 (G2'ye) → G5 (G4, G2) → G6 (G5) → G7 (G3, G6). Paralel koşarsan her biri ayrı worktree, birleştirdikten sonra tam test (`npm test`).

### Görev 1: spc: `capacity.yaml` + şema
**Dosyalar (spc repo):** `servers/medialog/capacity.yaml` (yeni), `servers/capacity.schema.json` (yeni), `tests/capacity-yaml.test.ts` (yeni); VLAD repo: `test/fixtures/spc/capacity-medialog.yaml` (kopya) + `test/fixtures/spc/provenance.json` kaydı.
- [ ] Biçim (`version: 1`, `server: medialog`, `source: D-medialog-062`, `warn_pct: 70`, `consecutive_weeks: 2`, `triggers[]`): alanlar `id, title, metric, labels?, measure (peak|daily_avg_peak), op ('>'|'>='), threshold (>0), unit, source_item`. Tetikleyiciler (D-medialog-062 madde 1 ve 4; eşikler `servers/medialog/rules.yaml` ile aynı): `ws-concurrent` (`app.ws_connections`, peak, 300), `proc-cpu` (`docker.container.cpu_pct`, `{name: medialog-app-1}`, daily_avg_peak, 60), `proc-mem` (`docker.container.mem_pct`, aynı, 60), `db-pool-waiting` (`app.db_pool_waiting`, peak, `>=` 1: eşik 0 olduğundan yüzde anlamsız, tam sayı sayaç `>= 1` ile ifade edilir), `http-p95` (`app.http_p95_ms`, peak, 1000). Ölçülemeyen maddeler (sıfır kesinti ihtiyacı, VM kaybı toleransı: madde 2 ve 3) `manual: [{id, title, source_item}]` altında yalnız bilgi.
- [ ] Şema JSON Schema (draft-07, `additionalProperties: false`); test dosyayı şemaya karşı doğrular ve metrik adlarının `rules.yaml`'da geçtiğini kontrol eder (kural/eşik sapması yakalanır). spc'de ajv yoksa `zod` (`packages/contract` bağımlılığı) ile aynı kısıtları yaz; şema dosyası yine de makine okunur belge olarak kalır.
- [ ] VLAD'a fixture kopyası + `provenance.json` (spc commit'i) eklenir (VLAD testleri spc reposuna bağlı olmasın).
- Doğrulama: spc'de `npx vitest run tests/capacity-yaml.test.ts`.

### Görev 2: bildirim kuyruğu + ntfy `publishNotice` + `pull` bağlantısı
**Dosyalar:** `src/monitor/notify.ts` (yeni), `src/approver/ntfy.ts` (yalnız `NtfyChannel.publishNotice`), `src/monitor/pull.ts` (küçük), `test/monitor/notify.test.ts`, `test/monitor/pull.test.ts` (ekleme), `test/approver/*` ntfy testi (ekleme).
- [ ] `notify.ts`: `enqueueNotice(dir, n)` (tmp+rename, 0700/0600, belirleyici ad), `listNotices(dir, {limit})`, `markDone(dir, id|all)`; hepsi hata yutan okuma tarafı (bozuk dosya atlanır, sayaç yalnız geçerlileri sayar). `defaultNotifyDir() = ~/.vlad-monitor/notify` (`monitorStateDir()` altında).
- [ ] `NtfyChannel.publishNotice({title,message})`: `post({topic: cfg.requestTopic, title, message, priority: 3, tags: ["robot"]})`, eylem yok. Test: sahte fetch ile gövde, eylemsizlik, https zorunluluğu.
- [ ] `PullDeps`'e opsiyonel `notifier?: { notice(n): Promise<void> }` (types.ts'e dokunmamak için `pull.ts` içinde genişleten arayüz). Varsayılan notifier: `readChannel()` varsa `publishNotice("VLAD görev açtı: <id>")` + `enqueueNotice`. `pullAlerts` her sunucu döngüsünün sonunda (hata olsa bile, çünkü görev zaten açıldı) `res.opened` için, `dry-run` değilse, bildirir. Notifier hatası `pull` sonucunu/çıkış kodunu değiştirmez (yalnız `log`).
- [ ] Testler: görev açılınca bir dosya + bir ntfy çağrısı; `resolved`/log-only/`dry-run`/tekrar çekişte yazma yok; ntfy kanalı yoksa kuyruk yine yazılır; ntfy hatası `pull` çıkışını etkilemez; kuyruk dosyasında alarm başlığı yok.
- Doğrulama: `npx vitest run test/monitor test/approver`.

### Görev 3: `monitor notices` komutları + SessionStart satırı
**Dosyalar:** `src/cli/groups/monitor.ts`, `src/commands/manifest.ts`, `src/commands/docs-data.ts`, `src/cli/groups/status.ts` + özet üreten `statusSummary` dosyası (grep `statusSummary`), `test/monitor/cli.test.ts`, `test/hooks/*` (özet satırı testi), `docs/commands.md` (üretilir).
- [ ] `vlad monitor notices list [--json]`, `notices count` (salt sayı, `Monitor` döngüsü için ucuz), `notices done <id>|--all`. Manifest: `list`/`count` `{ worker: LOCAL, console: { kind: "read" } }`, `done` `{ console: { kind: "write" } }` (kb'ye yazmaz, kilit yok); `docs-data.ts` açıklamaları. `npm run build && npm run docs:commands`.
- [ ] `statusSummary` `monitorNotices: {count, items: [{task, kind}]}` alır; satıra `, N monitor bildirimi (T…, T…)` eklenir (en çok 3 kimlik + "…"). Kuyruk okunamazsa sessizce 0 (SessionStart'ı asla düşürme; mevcut kb-lint tazeleme kalıbına bak). `test/arch` katman kuralını kontrol et (status → monitor/notify bağımlılığına izin yoksa okuyucuyu uygun katmana koy).
- [ ] Testler: boş/dolu/bozuk dizin; `--hook` JSON'unda satırın bulunması; `done --all` sonrası satır kaybolur.

### Görev 4: kapasite çekirdeği (yükleyici, istemci, hesap)
**Dosyalar:** `src/monitor/capacity-config.ts`, `src/monitor/capacity-fetch.ts`, `src/monitor/capacity-calc.ts` (hepsi yeni), `schemas/config.schema.json` + `src/kb` config tipi (`monitor.servers[].capacity_file?`), `test/monitor/capacity-*.test.ts`.
- [ ] `capacity_file` (spc checkout içindeki mutlak yol; yoksa sunucu kapasite işinden atlanır, `config` uyarısı). Yükleyici `yaml` + `ajv` ile (VLAD'da ikisi de bağımlılık) `capacity.yaml`'ı doğrular; şema VLAD'a `schemas/capacity.schema.json` olarak vendor edilir (başlıkta spc commit'i; Görev 1 fixture'ı gerçek dosya testidir).
- [ ] `capacity-fetch.ts`: `/spc/v1/since?resolution=1m&from=…&limit=5000` sayfalama; `pull.ts`ın `fetchPage` istek kuralları (Bearer, `redirect: "error"`, zaman aşımı, 401/403/410 sınıfları) paylaşılır/çoğaltılır; yalnız seçiciye uyan öğeler günlük kovalara. 410 → baştan bir kez. Sayfa tavanı (config'li, varsayılan 2000) aşılırsa `page_limit`, kısmi veri raporlanmaz.
- [ ] `capacity-calc.ts`: saf işlev; ölçü, yüzde, eğim, kalan süre, durum (`ok|warn|over|insufficient`). Birim testler sabit fixture: artan seri (kalan süre beklenen), düz seri ("artmıyor"), 3 haftadan az, eşik üstü, çok serili eşleşme, boşluklu veri, `>=` operatörü.
- Doğrulama: `npx vitest run test/monitor/capacity-*`.

### Görev 5: rapor, dedupe, architect görevi
**Dosyalar:** `src/monitor/capacity.ts` (yeni), `src/monitor/marker.ts` (`capacityMarker`/`parseCapacityMarker`, mevcut işlevlere dokunmadan), `src/monitor/capacity-state.ts` (yeni; `~/.vlad-monitor/capacity.json` v1, 0600 atomik), `test/monitor/capacity.test.ts`.
- [ ] `runCapacity(deps, {server?, dryRun?, force?, now})`: sunucu başına çek → hesapla → ISO hafta zaten işlenmişse atla (rapor yok) → rapor görevi (yoksa aç) günlüğüne tablo (`tetikleyici | 7g zirve | eşik | % | haftalık artış | kalan süre | durum`, veri başlangıcı notu) → `warn`/`over` için architect görevi (dedupe: durum + işaret taraması; açık görev varsa o görevin günlüğüne hafta özeti) → `over` ardışık ikinci hafta ise görev günlüğüne "TETİKLEYİCİ: 2 ardışık hafta" + bildirim → durum dosyası **kb yazmalarından sonra** kaydedilir (at-least-once + işaret idempotent).
- [ ] Bildirim: Görev 2'nin notifier'ı (`kind: "capacity"`); `dry-run` hiçbir şey yazmaz.
- [ ] Testler (gerçek geçici kb ile, `pull.test.ts` düzeni): ilk koşuda rapor görevi + `warn` için bir architect görevi (`role: architect`, `kind: research`, proje eşli proje, gövdede açık uçlu cümle ve işaret); ikinci hafta aynı tetikleyici için yeni görev açılmaz, açık görevin günlüğüne eklenir; aynı hafta tekrar koşu hiçbir yazma yapmaz; görev kapatılınca `warn` tekrar açmaz, `over` açar; iki ardışık `over` haftası "2 ardışık" notunu yazar, arada atlanan hafta seriyi sıfırlar; hata (ulaşılamaz) o sunucuyu atlar, diğeri sürer; `--dry-run` yazmaz.

### Görev 6: CLI, launchd, belgeler
**Dosyalar:** `src/cli/groups/monitor.ts`, `src/commands/manifest.ts`, `src/commands/docs-data.ts`, `src/monitor/launchd.ts`, `src/monitor/install.ts`, `test/monitor/cli.test.ts`, `test/monitor/units.test.ts` (plist/installer), `docs/commands.md`, `docs/` monitor belgesi (varsa).
- [ ] `vlad monitor capacity [--server <ad>] [--dry-run] [--force] [--json]`: `pull` ile aynı kilit (`lock: "outer"`), `console: { kind: "write" }`, çıkış kodları `MONITOR_EXIT` ile aynı. `docs-data.ts` açıklaması (kb'ye commit etmez notu dahil); `npm run build && npm run docs:commands`; manifest/docs testi eksiği yakalar.
- [ ] `monitorPlist` genelleştirilir (etiket, argümanlar, `StartInterval` ya da `StartCalendarInterval`); `com.vlad.monitor-capacity`: `Weekday 1, Hour 9, Minute 0`, günlük `~/.vlad-monitor/capacity.log` (0600). `createMonitorInstaller` iki plist'i idempotent kurar/siler; `status()` ikisini gösterir; `monitorInstallActions` iletisi güncellenir. Mevcut installer testleri (bootstrap sayısı vb.) güncellenir.
- Doğrulama: `npm run build && npx vitest run test/monitor test/commands` + `node dist/cli.js monitor capacity --dry-run --server medialog --json` gerçek ajana karşı (Keychain gerekir; kullanıcı Mac'inde; çıktı belirteç içermemeli).

### Görev 7: oturum davranışı ve uçtan uca doğrulama
**Dosyalar:** `CLAUDE.md` (kısa ek), `README.md` yalnız monitor bölümü varsa.
- [ ] `CLAUDE.md` "Açılış"a iki cümle: özet satırında `N monitor bildirimi` varsa `vlad monitor notices list --json` ile göster, kayıtlı göreve bak (`vlad kb get <id>`), triyaja başla (geçici mi yapısal mı), ardından `notices done`; açık oturumda `Monitor` aracıyla `vlad monitor notices count` değişimini izle (yalnız sayı değişince çıktı). `kind: capacity` bildirimi için `architect` görevini kullanıcıya sun. Metin kısa kalır; ayrıntı `docs/commands.md`'de.
- [ ] Uçtan uca (sahte ajan + geçici HOME/kb): `pull` → kuyruk dosyası → `status --summary --hook` satırı → `notices done`; `capacity` → rapor görevi + architect görevi → ikinci koşu hafta atlamasız. `npm test` (tam takım), `vlad kb lint` temiz.
- [ ] Gerçek denemeyi kullanıcıyla yap: `vlad monitor install` yeniden çalıştırma (TTY + mod yetkisi gerekir, VLAD kendisi yapamaz), `launchctl print gui/$UID/com.vlad.monitor-capacity`, ilk rapor `vlad monitor capacity --server medialog` elle.

## Riskler ve açık sorular (spec boşlukları)

1. **Ajanda özet/metrik süzgeci yok.** Spec "7/30 günlük özet" diyor; ajan yalnız tüm serileri içeren 1 dk akışı veriyor. 30 gün × tüm seri = milyonlarca öğe (5000'lik sayfalarla yüzlerce istek) haftada bir. Plan bunu istemci tarafı akış toplamasıyla çözer ve sayfa tavanı koyar; ölçülmeden yeterli sayma. Öneri: ilk gerçek koşuda süreyi ölç; ağırsa spec §8.6'daki "ekleyici alan" yetkisiyle ajana `/spc/v1/summary?metric=&from=&bucket=` eklenir (ayrı spc görevi, dağıtım adımına girer).
2. **Kapatılmış architect görevi sonrası davranış spec'te yok.** Plan: `warn`'da yeniden açma yok, `over`'da açar (aksi hâlde kullanıcı "şimdilik gerek yok" dedikten sonra her hafta görev açılır). Kullanıcı düzeltebilir.
3. **Atlanan hafta (Mac kapalı) "2 ardışık" sayılır mı?** Spec sessiz; plan serinin sıfırlanması (muhafazakâr) ve raporda belirtilmesidir.
4. **Kalıcı rapor görevi `queued` kalır** ve "aktif görev" sayısını bir artırır. Alternatif: raporu yalnız architect görevine yazmak (o zaman `warn` yokken rapor kaydı olmaz). Spec "rapor görev günlüğüne yazılır" dediği için sunucu başına tek uzun ömürlü görev seçildi.
5. **Eşik 0 olan tetikleyiciler** (`db_pool_waiting > 0`) yüzdeyle ifade edilemez; `>= 1` olarak kodlandı. D-medialog-062 madde 4'teki "p95 > 1 sn" için `app.http_p95_ms` metriğinin 1 dk özetinde `max` anlamı (p95'in zirvesi) kabul edildi; sürekli koşulu (`for`) bu raporda yoktur, yalnız zirve izlenir.
6. **spc checkout yolu** (`capacity_file`) kullanıcı makinesine özgü; ajan sürümüyle değil repo dosyasıyla çalışır. Dosya değişince yeni haftada geçerli olur.
7. **Yalnız macOS** (Keychain + launchd); Windows'ta komut `unsupported_platform` döner (pull ile aynı).
8. ntfy iletisi gizli konuya gider; konu sızarsa gözlemci "VLAD görev açtı" iletisini görür (kimlik dışında bilgi yok). Kabul.

## Doğrulama (iş bitti sayılır)

- `npm run build && npm test` yeşil (birleşmiş dal üzerinde); `npm run docs:commands` sonrası `docs/commands.md` diff'i yalnız yeni komutlar.
- spc: `tests/capacity-yaml.test.ts` yeşil.
- Gerçek: `vlad monitor pull --dry-run` etkilenmez; bir deneme alarmıyla (kullanıcı onayıyla) telefona "VLAD görev açtı: T…" gelir, `notices count` 1 döner, yeni oturum özet satırında görünür.
- `vlad monitor capacity --server medialog --dry-run --json` gerçek ajandan 7/30 gün hesabını belirteçsiz döker; gerçek koşuda rapor görevi oluşur ve `kb lint` temiz.
