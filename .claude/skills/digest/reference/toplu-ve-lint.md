# digest — toplu-ve-lint (reference)

> `SKILL.md`'den taşındı; metin aynen korunmuştur. SKILL.md'deki tetikleyici satır bu dosyayı okumanı söyler.

## Çok rapor (taslak agent'ları)

**Çok rapor (taslak agent'ları):** Raporlu görev sayısı büyükse (>10) ana bağlamı şişirmemek için proje (pipeline ise çatı) başına bir arka plan agent'ı (`sonnet`) başlat; her agent kendi grubunun görev dosyalarını okuyup günlük, kart, bulgu ve karar **taslağı** döndürür. Agent talimatına adım 3b (kullanıcı onayı kontrolü) aynen girer: onaylanmış konuyu açık nokta yazmasın, kaynağını belirtsin. Agent'lar kb'ye yazmaz; taslakları VLAD kontrol eder, `vlad` CLI ile yazar ve kartı doğrular (adım 3–6 aynen işler).

### 5c. kb çelişki denetimi (lint)

Kartlar, özetler, kararlar ve hafıza yazıldıktan sonra tüm kb için bir kez `vlad kb lint --json` çalıştır (Mac'te <1 sn; arka plan agent'ı gerekmez; sonucu `kb/logs/kb-lint.json` önbelleğine yazar ve `vlad status --summary` satırındaki "N kb çelişkisi" buradan gelir). Her işareti (`flags[]`: `code`, `file:line`, `id`, `suggestion`) CLI ile düzelt:
- `closed_finding_listed_open` / `finished_task_listed_active`: kart `## Açık konular`/sürüyor satırı elle yazılmış → `vlad project refresh <slug>`; blok dışı metinde satırı geçmişe çeviren düzeltmeyi `vlad project write` ile yap.
- `inactive_decision_listed_valid`: özet/kart listesinden kaldır (`vlad project summary`); geçerli liste `vlad decision list`.
- `expired_decision_valid`: süre gerçekten dolduysa `vlad decision set <id> geçersiz`; sürüyorsa kararı yeni `--until` ile yenile (`decision add --supersedes <id>`).
- `summary_stale`: adım 5b.
- `memory_stale_task` (hafıza dosyası, kb dışı): VLAD'a "hafızayı güncelle/sil" adımıdır, CLI yok; ilgili hafıza notunu düzeltir ya da silersin ve kullanıcıya söylersin.
Emin olmadığın işareti düzeltme: `vlad digest pending add --text "<kb lint: kod id dosya:satır — ne yapılmalı>" --project <slug>` ile onay bekleyen listeye ekle. Düzeltmelerden sonra `vlad kb lint` yeniden çalıştırıp işaret sayısının düştüğünü doğrula.
