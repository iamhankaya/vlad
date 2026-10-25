# vault/docs'u vlad-kb'ye taşıma (S5x)

S13a K7 kararı: vlad reposu public, `vault/docs` içeriği private projelere ait. Belgeler artık **`vlad-kb` reposunun kökündeki `docs/`** altında durur. Kod bunu şöyle çözer; içerik taşıma elle yapılır.

## Kod davranışı

| Düzen | docs kökü |
|---|---|
| Ayrı kb (`VLAD_KB_DIR` ya da `kbDir`) ve `<kb>/docs` var | `<kb>/docs` |
| Ayrı kb ama `<kb>/docs` henüz yok | `<VLAD_HOME>/vault/docs` (yedek) |
| Eski düzen (kb vlad reposunun içinde) | `<VLAD_HOME>/vault/docs` |

- Sanal yol her durumda **`vault/docs/…`** kalır. `vlad vault search|read|ls`, `/v1/vault/*` uçları ve mobil uygulama değişmez.
- `<kb>/docs` bulunduğunda `<VLAD_HOME>/vault/docs` artık okunmaz ya da aranmaz (eski kopya yanlışlıkla sunulmaz).
- Ayrı kb düzeninde `kb/docs/…` yolu **reddedilir**; docs yalnız `vault/docs/…` olarak görünür (çift sonuç olmaz).
- docs kökü bir symlink olamaz; symlink ise kök sayılmaz (yedeğe düşülür). İçerideki symlink'ler kök dışına ya da yasak klasörlere (`inbox`, `logs`, `grants`, `audit`) çıkamaz.
- Yalnız `.md` dosyalar, en çok 1 MiB, UTF-8, ikili değil. Promote kuralı (`bad_extension`, `too_large`) ile aynı.
- Yol kuralları (yeni kökte de): mutlak yol, `..`, `\`, `%xx` (çift kodlama dahil), null/kontrol karakteri, sondaki nokta/boşluk, `:`, `~n`, nokta ile başlayan ad, büyük/küçük harf ve Unicode varyantları.

- Dizin yarışı: arama her dizini listelemeden önce ve sonra, her dosyayı açtıktan sonra yolun hâlâ kendi gerçek yolu olduğunu, izin bölgesinde kaldığını ve açılan dosyayla (dev/ino; Linux'ta `/proc/self/fd`) aynı olduğunu doğrular. Biri araya symlink sokarsa o dal atlanır.
- `vlad status` (ve `--summary`) yedek kök kullanılıyorsa ya da `<kb>/docs` yanında eski `vault/docs` duruyorsa uyarı verir: `docs kökü: kb/docs (eski vault/docs artık okunmuyor)`. Tam `vlad status` kök değişimini bir kez `<kb>/logs/docs-root.log`'a yazar. Eski `vault/docs` silinince uyarı kalkar.

## Taşıma adımları (Windows, kullanıcı)

1. `vlad kb pull` ve `git -C C:\dev\vlad-kb status` ile kb deposunun temiz olduğunu doğrula.
2. İçeriği kopyala (geçmiş vlad reposunda kalır; `vault/` hiç izlenmediyse yalnız yerel dosyalardır):
   ```powershell
   robocopy C:\dev\vlad\vault\docs C:\dev\vlad-kb\docs /E
   ```
3. Yalnız `.md` olmayan dosyaları ve 1 MiB üstü dosyaları ayıkla (görseller `docs/`'ta kabul edilmez, promote reddeder): `Get-ChildItem C:\dev\vlad-kb\docs -Recurse -File | Where-Object { $_.Extension -ne '.md' -or $_.Length -gt 1MB }`.
4. Ad kurallarına uymayanları düzelt: segment `^[A-Za-z0-9][A-Za-z0-9._-]*$`, en çok 180 karakter ve 4 derinlik, Windows ayrık adları (`aux`, `con` …) yok.
5. Doğrula: `vlad vault ls vault/docs` ve `vlad vault search <bir kelime> --zone docs` taşınan dosyaları göstermeli.
6. `vlad kb commit "kb: docs'u vlad-kb'ye taşı" --push`.
7. Emin olunca `C:\dev\vlad\vault\` silinebilir. vlad reposunun `.gitignore`'unda `/vault/` vardır; yanlışlıkla commit edilmez.

Geri dönüş: `<kb>/docs` klasörünü kaldırmak kodu otomatik olarak `<VLAD_HOME>/vault/docs` yedeğine döndürür.
