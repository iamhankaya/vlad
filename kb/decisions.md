# Karar Günlüğü

### 2026-10-16 — vlad — Uzman roller roles/ dosyaları ve prompt ile
- **Karar:** Uzman roller VLAD reposunda `roles/<slug>.md` (frontmatter `slug/title/kind/summary`, şemayla doğrulanır) olarak tanımlanır ve prompt ile enjekte edilir; danışmanlar (`advisory`) research görevinde arka plan agent'ı, uygulayıcılar (`executor`) dev görevinde çalışan persona'sı olur. Görevde `role` alanı, `vlad task new --role`.
- **Gerekçe:** Claude Code agent kayıt mekanizmasına (`--agent` bayrakları, frontmatter ayrıştırma) bağımlılık yok; tek doğruluk kaynağı; yeni rol = yeni Markdown dosyası. Alternatifler (`.claude/agents/`, yalnızca görev metni) spec §3'te.
- **Kaynak:** docs/superpowers/specs/2026-10-15-vlad-roles-design.md, merge 9b14552

### 2026-10-16 — vlad — Yazılım departmanı: rol tabanlı pipeline, döngü boyutunu VLAD seçer
- **Karar:** Yazılım departmanı = rol tabanlı iş akışı (pipeline). Döngünün boyutunu (tam: analist → mimar+developer → tester ∥ developer; kısa: developer + tester; tek: developer) VLAD işin boyutuna ve netliğine göre seçer, emin olmadığında kullanıcıya sorar. Her faz bir dosya üretir (spec, plan, test matrisi); fazlar arası onay kapıları kullanıcıda (en az spec ve merge). Rollere skill'ler rol dosyasındaki `skills:` alanıyla bağlanır; önce mevcut skill'ler, eksik kalan yöntem olursa yeni skill.
- **Gerekçe:** Ajan sohbetleri hafıza değildir, kb/ dosyaları hafızadır; küçük işte tam döngü işin kendisinden pahalı; rol = ne/sınır, skill = nasıl.
- **Kaynak:** kullanıcıyla görüşme 2026-10-16; ayrıntılı tasarım pipeline spec'inde yapılacak.

### 2026-10-18 — vlad — Designer rolü ve pipeline'daki yeri
- **Karar:** Yazılım departmanına `designer` (Senior UI/UX Designer, `executor`) rolü eklendi. Skill'ler: `ui-ux-pro-max`, `impeccable`, `design-taste-frontend` (taste-skill). Yalnızca kullanıcıya görünen arayüz varsa devreye girer: `tam`/`özellik`'te spec'ten sonra `tasarım` fazı (tam'da plandan önce), üç döngüde de `doğrulama` ile paralel `denetim` fazı.
- **Dosya sahipliği:** Designer yalnızca `docs/design/` yazar; stil/token dosyaları dahil üretim kodu developer'ındır (seçenek A).
- **Gerekçe:** Architect bileşen yapısını tasarıma göre planlar; denetim bulguları doğrulamadaki kırmızı test kuralıyla aynı kapıdan geçer.
- **Kaynak:** vlad-53

### 2026-10-18 — diskpilot — DiskPilot v1 planı ve pipeline yapısı
- **Karar:** DiskPilot v1 planı (T20261016-04) kabul edildi. Varsayılanlar onaylandı: (1) K8/K9 AppData'yı ve .vhdx/.vhd/.vmdk/.pst/.ost/.avd/.qcow2 dosyalarını dışlar; (2) ağaçta "Hesaplanamayan alan" satırı, S1.2 ±%5 yalnızca yönetici taramasında; (3) kalıcı silme onayı yalnızca tam `SİL`; (4) aktif projenin node_modules/bin/obj'i Dikkat ve işaretsiz; (5) remote'u olmayan repodaki worktree "push edilmemiş" diye kilitlenmez; (6) "sonra kutuyu boşalt" seçilirse `SİL` diyaloğu; (7) Windows.old korumalı listede (yalnızca bilgi + Disk Temizleme düğmesi); (8) kilitli dosya içeren klasör bütün olarak atlanır. Spec cevapları: normal kullanıcı + "Yönetici olarak yeniden başlat", %TEMP% 7 gün.
- **Pipeline değişikliği:** Plandan sonra designer fazları eklendi (kullanıcı isteğiyle tasarım plandan sonra) ve kabul testlerinin sözleşmelere ihtiyacı nedeniyle ayrı bir developer "sözleşme" fazı açıldı: plan → (tasarım ∥ sözleşme) → (kabul ∥ uygulama) → (doğrulama ∥ denetim). Eski -05/-06/-07 iptal edildi.
- **Gerekçe:** Architect: kabul fazı Görev 1b sözleşmeleri merge edilmeden başlayamaz. Designer rolü bu pipeline oluşturulduktan sonra eklendi.
- **Kaynak:** T20261016-04

### 2026-10-20 — vlad — VLAD bulut çalışma modeli: kb branch'i, PR kapıları, izleme, ID aralığı, çalışan push'u
Spec T20261020-02 kapısında kullanıcı onayladı (2026-10-20):
1. Bulut VLAD'ın `kb:` commit'leri session branch'ine gider; `master`'a onaylı merge ile alınır.
2. Bulutta merge kapıları (faz → `vlad/<çatı-id>`, çatı → `master`) GitHub PR üzerinden: PR açılır, kullanıcı onaylar, VLAD merge eder.
3. Bildirim: yalnızca izleme (`/status` her çağrıda `get_session`/`list_events`); zamanlı kontrol yok (kullanım limiti). Kartta `local_only` (+ `local_only_reason`) alanı kabul.
4. Görev ID çakışması: bulut VLAD günlük sıra numarasını `51`'den başlatır (ör. `T20261020-51`).
5. Bulut çalışanları yalnızca kendi `vlad/<id>` branch'lerine push eder (kalıcı kural); `master`'a asla.
Gerekçe: bulut session'ı yalnızca kendi branch'ine push edebilir; çalışanın geri mesajı garanti değil; container geçici.
- **Kaynak:** T20261020-02

### 2026-10-20 — vlad — Bulut çalışanları için tek seferlik hatırlatmalar
2026-10-20 "VLAD bulut çalışma modeli" kararının 3. maddesi güncellendi (kullanıcı onayı): bulut çalışanları temiz bitişte VLAD'a haber vermediği için VLAD, her bulut çalışanını başlattıktan sonra kendi session'ına tek seferlik hatırlatma (`send_later`, ~15 dk) kurar. Hatırlatmada çalışan bitmemişse yeniden kurar; çalışan başına en fazla 4 deneme. Sürekli yoklama yok. Yalnızca bulut modu; yerelde `SendMessage` bildirimi değişmez.
İleride denenecek: çalışanın bitişte VLAD session'ına tek seferlik zamanlanmış görev kurarak haber vermesi (hızlı yol; hatırlatma yedek).
- **Kaynak:** T20261020-05

### 2026-10-20 — vlad — System design architect'te; exposure alanına göre ölçeklenir
- **Karar:** System design ayrı bir role bölünmez; architect `### Sistem tasarımı` bölümünü kartın `exposure` alanına göre ölçekleyerek yazar (`local` kısa, `network` orta, `internet` tam; etkisizse tek satır gerekçe). Analyst spec'e `### Sistem etkisi` ekler. `exposure` stack'ten tahmin edilmez, kullanıcıya sorulur; `local_only` (bulutta derlenebilir mi) ayrı bir alandır.
- **Gerekçe:** Ayrı rol her büyük döngüye bir faz ve soğuk başlangıç ekler (kullanım limiti); sunuculu proje şimdilik yalnızca watchparty; altyapı kararları ile bileşen yapısı aynı agent'ta tutarlı kalır.
- **Kaynak:** sohbet 2026-10-20 / görev T20261020-53 (PR #15)
- **Kaynak:** T20261020-53

### 2026-10-20 — vlad — Tüm roller Sonnet ile çalışır
- **Karar:** Uygulayıcı ve danışman rollerin hepsi `model: sonnet` taşır; VLAD'ın kendi session'ı varsayılan modelde kalır. Dev çalışanı `claude --model`, research agent'ları Agent `model` parametresiyle başlar.
- **Gerekçe:** Kullanım limiti tasarrufu.
- **Kaynak:** görev T20261018-07 (commit d00e020); roller spec'i §4
- **Kaynak:** T20261018-07

### 2026-10-20 — medialog — medialog v1 kapsam kararları (anime TMDB'den, gizlilik, veri hakları)
- **Karar:** medialog v1 kapsamı spec T20261020-59'daki önerilerle kabul edildi: animeyi TMDB'den al (AniList yok; izin gelirse v2); site reklamsız ve ücretsiz (TMDB ticari olmayan şartı); e-posta doğrulaması ve parola sıfırlama v1 (gönderim servisini architect seçer); son bölümde "sıradaki bölüm" tek tıkla "izledim"e geçmeyi sorar; "herkese açık" profil girişsiz görünür ama noindex; yeni hesap varsayılanı "arkadaşlara"; hesap silinince mesajlar "silinmiş kullanıcı" olarak anonimleşir; JSON dışa aktarma, engelleme ve şikâyet (yalnızca kayıt) v1; arayüz Türkçe, içerik başlığı Türkçe varsa Türkçe yoksa orijinal; alan adı/barındırma için architect düşük maliyetli öneri getirir; arkadaş aktivite akışı v2.
- **Gerekçe:** AniList şartları rakip takip servisinde kullanımı izne bağlıyor (yasal risk); TMDB tek API ile dizi+anime sezon/bölüm yapısını karşılar. Diğerleri internet exposure'da gizlilik ve KVKK/GDPR gereği.
- **Kaynak:** görev T20261020-59 (spec), kullanıcı onayı 2026-10-20
- **Kaynak:** T20261020-59

### 2026-10-20 — medialog — medialog v1 planı: TypeScript yığını, 6 dikey uygulama fazı
- **Karar:** medialog v1 planı (T20261020-61) önerilerle kabul edildi: yığın A — TypeScript tam yığın (Node 22 + Fastify + `ws` + React/Vite + PostgreSQL 16; `pg` + parametreli SQL + `zod`, ORM yok); uygulama 6 dikey faza bölünür (U1 temel/oturum, U2 arama/detay, U3 listeler/ilerleme, U4 sosyal/gizlilik, U5 sohbet/şikâyet, U6 hesap/veri hakları; her fazda kabul ∥ uygulama), U7 dağıtım isteğe bağlı ve ayrıca onaylı; kayıttan sonra otomatik oturum yok (e-posta doğrulamasıyla oturum açılır; hesap sayımı sızmasın); başkasının listesinde not gizli, puan görünür; parola sıfırlama e-postayı doğrulanmış sayar; anime = TMDB animasyon türü (16) + orijinal dil `ja` (anime sekmesinde eksik sonuç kabul); kapalı konuşma mesajları 30 gün sonra silinir; barındırma önerisi (Hetzner + .com + Resend + B2/R2, ~5–7 €/ay) U7'de kesinleşir.
- **Gerekçe:** Bulut çalışanlarında derlenip test edilebilen tek yığın A; tek dil/tek sözleşme; dikey dilimler çalışan oturumuna sığar ve her kapıda çalışan bir kullanıcı akışı bırakır.
- **Kaynak:** görev T20261020-61 (plan, developer+tester eleştirileriyle), kullanıcı onayı 2026-10-20
- **Kaynak:** T20261020-61

### 2026-10-20 — medialog — medialog faz merge kapıları VLAD'a devredildi
- **Karar:** medialog v1 pipeline'ında (T20261020-58) faz kapıları VLAD'a devredildi: VLAD fazların kabul + uygulama branch'lerini yerelde birleştirip build, birim, lint ve kabul testlerini çalıştırır; hepsi yeşilse ve merge önerisi varsa sormadan PR açıp entegrasyon branch'ine (`vlad/T20261020-58`) merge eder ve sıradaki fazları başlatır. Kırmızı varsa önce düzeltme turu ister.
- **Kapsam dışı:** son kapı (`vlad/T20261020-58` → `main`) ve dağıtım (U7) yine ayrıca açık onay ister.
- **Kaynak:** kullanıcı 2026-10-20, T20261020-58

### 2026-10-20 — medialog — Gece boyu otonom yürütme: v1 bitiş, güvenlik denetimi, canlıya alma, Faz 2
- **Karar:** Kullanıcı (2026-10-20 akşam) gece boyunca medialog'u VLAD'ın yürütmesini istedi: v1'i bitir; canlıya almadan hemen önce `security-audit` skill'i (cloudflare/security-audit-skill, repoya eklendi f1c55ff) ile güvenlik incelemesi yaptır; mümkünse v1'i canlıya al (U7 dağıtım + `vlad/T20261020-58` → `main` son kapısı bu talimatla onaylı); alamıyorsan kullanıcıdan ne gerektiğini söyle. Ardından Faz 2'yi baştan sona yürüt: spec → plan → (gerekirse) tasarım → geliştirme + test → iterasyon; her kapıyı VLAD kendi onaylar (spec/plan/tasarım "tamam" kararı, testler yeşil + inceleme), "uygulama tamamen hazır" diyene kadar.
- **Sınırlar (VLAD yorumu):** para harcamak, hesap açmak, DNS/alan adı/üçüncü taraf hesap işlemleri, sırların yazılması kullanıcıdadır; gerçek dağıtım yalnızca kullanıcının sağladığı altyapı ve GitHub repo sırlarıyla (Actions) yapılır. Kullanıcı kararı gerektiren ürün sorularında VLAD makul varsayımı seçip karar günlüğüne ve sabah özetine yazar. Güvenlik denetiminde kritik/yüksek bulgu varsa canlıya alma düzeltme turundan sonra.
- **Kaynak:** kullanıcı 2026-10-20, T20261020-58

### 2026-10-20 — medialog — medialog v2 spec kabulü ve varsayılanlar
- **Karar:** medialog v2 spec'i (T20261020-85) VLAD tarafından kabul edildi (gece otonom yürütme kararı). Kapsam Must: arkadaş aktivite akışı (varsayılan açık, 90 gün, geçmişe dönük doldurma yok), yayın takvimi (active+planned, 14 gün, Europe/Istanbul), site içi bildirim merkezi, MAL/Letterboxd/Goodreads içe aktarma (ZIP yok; yalnız güvenli eşleşme; çakışmada atla; MAL On-Hold→active, Dropped→atla), istatistikler (`watch_log` + `content_facts`, "tahmini" etiketi), minimal yönetici + şikâyet kuyruğu (yalnız CLI ile yetki, 15 dk yeniden doğrulama, askı 1/7/30/süresiz). Should: haftalık e-posta özeti (varsayılan kapalı, günlük 80 bütçe), yıllık özet, gizli etiketler, şikâyet kategorisi, F12–F20, logo/favicon (VLAD üretir: metin wordmark + SVG favicon), TMDB logosu (doğrulanamazsa yalnız metin). Won't: grup sohbeti, web push, OAuth, AniList, yeni liste durumları, tepki/yorum. Diğer 27 açık soruda spec'teki VLAD varsayılanları geçerli.
- **Kaynak:** VLAD (otonom), T20261020-85

### 2026-10-20 — medialog — medialog v2 plan kabulü
- **Karar:** medialog v2 son planı (T20261020-86; architect taslak + developer/tester eleştirileri) VLAD tarafından kabul edildi. 21 faz: V0a/V0b tasarım; V1a (davranış çekirdeği: zamanlayıcı + ayrı kilit havuzu, clock, listener, 0006), V1b (iskelet/sabitler/kabuk kayıt defteri), V1T (tester altyapısı: runJobAsync/--now/pid, fake genişlemesi, conventions), V1c (denetim kalanları; G1'i bloklamaz); G1 kapısından sonra paralel V2 akış, V3a-1/2/3 takvim-bildirim, V3b e-posta özeti, V4a-1/2 + V4b içe aktarma, V5a istatistik, V5b etiket, V6a/V6b moderasyon; V7a bütünleşik doğrulama, V7b security-audit, V7c a11y/tarayıcı/ops. Askı `suspended_forever` (infinity yok); iş/Outbox SQL'inde `now()` yasak (clock parametresi); `watch_log` konum tabanlı; WS `notification.new` yalnız `hello.features` isteyene. v2 entegrasyon branch'i `vlad/T20261020-84` v1 `main`'e alındıktan sonra `main`'den açılır; `docs/spec/v2.md` ve `docs/plan/v2.md` oraya commit'lenir. v1 son düzeltme fazı denetim N1–N15'i kapsadığı için V1c yalnız kalanları alır.
- **Kaynak:** VLAD (otonom), T20261020-86
