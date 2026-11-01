---
name: setup-audit
description: VLAD kurulumunun periyodik denetimi — biten görevlerin ölçümlerinden, açık noktalarından ve sürtünme işaretlerinden eksik/fazla/skill adayı/mod adayı/kural önerisi/bulgu hijyeni çıkarır, raporlar. Kullan - kullanıcı "/setup-audit", "kurulumu denetle", "neyi otomatikleştirmeliyiz" dediğinde.
---

# /setup-audit — kurulum denetimi

Kullanıcı `/setup-audit` dediğinde **onay sormadan** yürür (skill çağrısı onaydır). Kendisi hiçbir dosyayı, kuralı, rolü ya da skill'i **değiştirmez**; çıktısı yalnız rapor ve kullanıcının seçtikleri için görev taslağıdır.

## 1. Aralık

- `--since YYYY-MM-DD` verildiyse onu kullan.
- Yoksa son denetimin tarihi: `vlad task list --json --fields id,title,state,created --limit 200` çıktısında başlığı `Kurulum denetimi` ile başlayan ve `state` değeri `done` ya da `awaiting_approval` olan (iptal/yarım kalmış sayılmaz) en yeni görevin `created` günü. Hiç yoksa bugünden 14 gün öncesi. Aynı gün biten görevler iki denetimde de görünebilir; çift saydığın kanıtı öneride belirt.
- Aralığı kullanıcıya tek satırda söyle.

## 2. Görev

```
vlad task new --project vlad --kind research --role analyst --title "Kurulum denetimi <YYYY-MM-DD>" --body-file <geçici.md> --json
vlad task set <id> running
```
Gövde: aralık ve amaç (bir iki satır). Onay istenmez.

## 3. Veri toplama

```
vlad audit setup --since <tarih> --json
```
Çıktı (salt okuma): `tasks` (sayı, rol/faz/model dağılımı), `measures.sums` (review_bulgusu, ci_tur, yeni_test…), `open_points` (önem dağılımı), `signals` (`test_itirazi`, `degisiklik_istegi`, `karar`, `izin_reddi`: görev sayısı, adet, örnek ID'ler), `skills.inventory` (kaynak, hangi roller adlandırıyor, yüklenme sayısı) + `unused`, `findings.unresolved` (yaşa göre).

Ana bağlamı şişirme; ham veriyi okuyup yorumlamayı arka plan agent'larına ver, ana bağlama yalnız özet girer:
- **haiku:** sayım ve çıkarım (tablolar, dağılımlar, ID listeleri).
- **sonnet:** sınıflandırma ve örüntü arama (aşağıdaki kategoriler). Örnek ID'lerin kapanış raporlarını `vlad kb get <id> --section "## Kapanış raporu" --json` ile okutur.

Agent'lar kb'ye yazmaz; sonuç taslaktır, kanıt ID'lerini VLAD örnekleyerek doğrular.

`skills.unused` yalnız oturum kaydı bulunan görevlerden (`skills.transcripts`) ve VLAD oturumundan çıkar; kayıt sayısı azsa ya da görevlerin çoğunda kayıt yoksa "Fazla" önerisi yazma, bunu `### Açık noktalar`a veri sınırı olarak yaz.

Sinyal okuma: `ci_tur` ve `review_bulgusu` yüksekse tekrarlı bir kalıp var mı bak; `test_itirazi`/`degisiklik_istegi` yüksekse kabul/sözleşme fazı ya da rol talimatı zayıf olabilir; `izin_reddi` tekrarı izin kuralı ya da mod penceresi adayıdır.

## 4. Sınıflandırma

Her öneri şu kategorilerden birine girer:

| Kategori | Ne |
|---|---|
| **Eksik** | Tekrarlı elle yapılan iş, CLI/komut/otomasyon boşluğu |
| **Fazla** | Kullanılmayan skill/rol/komut, ölü ya da çelişen kural (`skills.unused`, hiçbir rolün anmadığı skill) |
| **Skill adayı** | En az 3 görevde tekrarlanan aynı akış (kanıt: ≥3 görev ID'si) |
| **Mod adayı** | Tekrarlı yetki/izin pencereleri, aynı onayın sık istenmesi (`vlad mode` ile çözülebilir) |
| **Kural/rol önerisi** | `CLAUDE.md` ya da `roles/` değişikliği; çalışma notu adayı |
| **Bulgu hijyeni** | Çok eski (`age_days`), aslında kapanmış ya da artık geçersiz açık/ertelenmiş bulgular; `vlad finding set` önerisi |

Her öneride zorunlu alanlar: **kanıt ID'leri** (görev/bulgu/karar; kanıtsız öneri yazma), **etki** (ne kazanılır), **efor** (S/M/L), **öncelik** (yüksek/orta/düşük). Tahmin yürütme: veride dayanağı olmayan öneri yazma. ≥3 görev şartını sağlamayan "skill adayı" `Kural/rol önerisi` ya da `Eksik`'e iner.

## 5. Rapor

Raporu geçici bir dosyaya yaz (`###` başlıklar; `## ` yok):
```
### Özet
(aralık, görev sayısı, ölçüm toplamları, sinyal sayıları)
### Öneriler
(kategoriye göre tablo: # | öneri | kanıt | etki | efor | öncelik)
### Açık noktalar
(- [önem] başlık — ayrıntı; veri yetersizliği, oturum kaydı olmayan görevler)
```
ve:
```
vlad task report <id> --file <rapor.md>
```
Sonra kullanıcıya aynı öneri tablosunu sohbette göster ve hangilerinin uygulanacağını sor. Seçilenler `/delegate` ile görev olur (taslak onayı orada alınır); seçilmeyenler için bir şey yapma. Görev `awaiting_approval`'dan `/status` akışıyla kapanır.
