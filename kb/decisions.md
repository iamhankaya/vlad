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
