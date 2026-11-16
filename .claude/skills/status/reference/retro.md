# status — retro (reference)

> `SKILL.md`'den taşındı; metin aynen korunmuştur. SKILL.md'deki tetikleyici satır bu dosyayı okumanı söyler.

### Retro (son kapıdan sonra)

Retro ve "nerede kalmıştık" soruları için kart/günlük dosyalarını baştan okuma: önce `vlad project status <slug> --json`, gerekirse `vlad kb search "<sorgu>" --project <slug> --json`.

Retrodan önce `integrate` K8'deki bayat özet kontrolünü uygula (çatının projesinin özeti `bayat` ise `/digest` öner; güncellenmezse sonraki "nerede kalmıştık" yanıtı eskiyi gösterir).

Çatı `done` olunca kısa bir retro yap (2–5 dakikalık özet; uzun rapor yazma). Kaynak: çatı ve faz görev dosyaları (`## İlerleme`, `## Sorular`, `## Kapanış raporu`), `failed`/`cancelled` fazlar, geri alınan merge'ler, kırmızı gate koşuları.
1. Kullanıcıya üç başlıkta göster: **Ne iyi gitti**, **Ne sürtündü** (tekrar eden hata, ortam sorunu, çakışma, limit kesintisi, geç yakalanan bulgu), **Ders** (somut, bir cümle, eyleme dönük).
2. Proje düzeyindeki dersleri kullanıcı onayıyla karta yaz (her ders ayrı komut; kart gövdesi elle düzenlenmez):
   ```
   vlad project note <slug> "<ders>" --json
   ```
   Notlar kartın `## Çalışma notları` bölümüne tarihli madde olarak eklenir; çalışanlar ve roller işe başlarken bunu okur. Aynı ders zaten notlardaysa ekleme.
3. **Rol düzeyindeki** dersler (bir rolün sorumluluk/yetki/çıktı kuralı değişmeli) kartı değil `roles/<slug>.md`'yi ilgilendirir: bunları kullanıcıya **öneri** olarak sun (hangi rol, hangi satır, neden). Onaylanırsa `roles/` değişikliği ayrı bir görev olarak `/delegate` ile açılır; VLAD rol dosyasını kendisi düzenlemez.
4. Skill kullanımı: `vlad audit skills --since <çatı-tarihi> --json` çıktısından kısa tablo ver (görev başına beklenen/yüklenen/eksik; VLAD'ın `second-opinion`/`integrate` eksiği dahil). Tekrarlayan eksik rol/skill düzeyindeyse `roles/` önerisi, projeye özgüyse kartın `skills` listesi ya da `vlad project note` olur.
5. Retroda ortaya çıkan, düzeltilmemiş sorunları bulgu olarak kaydet: `vlad finding add --project <slug> --severity <…> --source <çatı-id> --title "<…>" --json`.
6. Sonunda `vlad kb commit "retro <çatı-id>" --push --json`.
