---
name: scan
description: Kullanıcının kök klasörlerindeki repoları tarar ve kb/projects altındaki proje kartlarını oluşturur veya günceller. Kullanıcı "projeleri tara", "yeni projeleri bul", "kartları güncelle" dediğinde ya da bilinmeyen bir projeden söz ettiğinde kullan.
---

# /scan — proje keşfi ve kartlar

Amaç: Her repo için doğru ve güncel bir proje kartı (`kb/projects/<slug>.md`). Ham bilgiyi CLI toplar; kartı **sen** yazarsın, CLI doğrulayıp kaydeder.

## Akış

1. **Tara:**
   ```
   vlad scan --json
   ```
   Her repo için: `slug`, `path`, `readme` (ilk 4 KB), `manifest` (package.json/pyproject özeti), `commits` (son 20), `hasCard`.
2. **Mevcut kartları al:**
   ```
   vlad project list --json
   ```
   `hasCard: true` olan repolar için mevcut kartı `kb/projects/<slug>.md`'den oku (yalnızca okumak için).
3. **Her repo için kartı hazırla.** Biçim:
   ```markdown
   ---
   slug: watchparty
   name: WatchParty
   path: C:\dev\watchparty
   stack: [typescript, react]
   status: active
   autonomy: commit
   exposure: internet
   last_activity: 2026-10-15T21:10:00+03:00
   last_scanned: 2026-10-15T21:30:00+03:00
   ---
   ## Özet
   ## Mimari notlar
   ## Açık konular
   ## Son aktivite
   ```
   - `slug` dosya adıyla aynı, yalnızca `a-z0-9-`.
   - `stack`: manifest ve README'den çıkar; emin olmadığını yazma.
   - `autonomy`: `vlad.config.json`'daki `projects.<slug>.autonomy`, yoksa `defaultAutonomy`.
   - `last_activity`: en son commit tarihi (yoksa `null`); `last_scanned`: şimdi, yerel ofsetli ISO 8601.
   - `exposure` (opsiyonel; `local | network | internet`): sisteme kimin eriştiğini söyler ve architect'in sistem tasarımını ölçekler. **Yeni projede stack'ten veya README'den tahmin etme; kullanıcıya sor** ("Bu sistem yalnızca bu makinede mi (`local`), yerel ağda mı (`network`), internete açık mı (`internet`)?") ve cevabı karta yaz. Mevcut kartta alan boşsa kartı değiştirme, özette "exposure belirsiz" diye listele ve sor. Alan `local_only`'den farklıdır: `local_only` bulutta derlenip çalışıp çalışmadığını, `exposure` erişim kapsamını anlatır; ikisi bağımsız kalır.
   - `status`: yeni kartta `active`; mevcut kartta kullanıcının değerini koru.
   - **Mevcut kartta** `## Mimari notlar`, `## Açık konular`, `## Son aktivite` içeriğini koru; yalnızca yanlış/eskimiş olanı düzelt. `## Özet`'i README ve commit'lere göre güncelle.
4. **Yaz:** Kartı geçici bir dosyaya yaz ve:
   ```
   vlad project write <slug> --file <geçici.md> --json
   ```
   Şema hatası gelirse `details`'teki alanı düzeltip tekrar dene; iki denemede olmazsa kullanıcıya hatayı göster.
5. Kart dosyalarını asla doğrudan Write/Edit ile değiştirme.
6. **Hafızayı commit'le:** `vlad kb commit "scan: <yeni/güncellenen slug'lar>" --push --json`. Hata verirse kullanıcıya söyle; kartlar yine de yazılmıştır.

## Kullanıcıya göster

Kısa bir Türkçe özet:
- **Yeni projeler:** slug, yol, stack (tek satır).
- **Güncellenen kartlar:** neyin değiştiği (ör. "son aktivite 3 gün önce → bugün", "stack'e vite eklendi").
- **Değişmeyenler:** yalnızca sayı.
- **exposure belirsiz:** `exposure` alanı boş olan mevcut kartların slug listesi (sorulması gerekenler).
- **Hatalar:** yazılamayan kartlar ve nedeni.

Çok sayıda (10+) yeni repo bulunursa hepsini yazmadan önce listeyi göster ve hangilerinin kart alacağını sor (ör. denemeler, arşiv klasörleri).
