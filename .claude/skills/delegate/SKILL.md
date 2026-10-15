---
name: delegate
description: Bir projede yapılacak işi görev olarak tanımlar, kullanıcı onayından sonra oluşturur ve çalışan session'ını başlatır (dev) ya da arka plan agent'ıyla yürütür (research). Kullanıcı "X projesinde Y'yi yap", "şunu bir çalışana ver", "şunu araştır" dediğinde kullan.
---

# /delegate — görev tanımla, onayla, başlat

**Onay kapısı:** Kullanıcı taslağı açıkça onaylamadan `vlad task new` **çalıştırılmaz**. Onay = "evet", "tamam", "başlat" gibi açık bir cevap. Düzeltme isterse taslağı güncelleyip yeniden göster.

## 1. Bağlamı topla

```
vlad project list --json
```
- Projeyi slug ile eşle; belirsizse kullanıcıya sor. Kart yoksa önce `/scan` öner.
- `kb/projects/<slug>.md` kartını oku (özet, mimari notlar, açık konular).
- `kb/decisions.md` içinde bu projeye ait ilgili kararları oku.
- Aynı konuda açık görev var mı bak:
  ```
  vlad task list --project <slug> --json
  ```
  Varsa kullanıcıya söyle (çakışma/tekrar riski).

## 2. Taslağı hazırla ve göster

Türü belirle:
- `dev`: repoda kod değişikliği → ayrı, görünür çalışan session'ı (worktree + `vlad/<id>` branch'i).
- `research`: kod değiştirmeyen kısa iş (araştırma, özet, inceleme) → VLAD içinde arka plan agent'ı.

Kullanıcıya şunu göster:
```markdown
**Proje:** <slug>   **Tür:** dev|research   **Yetki:** <autonomy, karttan>
**Başlık:** <kısa başlık>

## Tanım
<ne yapılacak, neden>

## Kabul kriterleri
- [ ] <test edilebilir kriter>

## Bağlam
<ilgili kararlar, dosyalar, kısıtlar; kaynak ID'leriyle>
```
Sonunda sor: "Bu görevi oluşturup başlatayım mı?"

## 3. Onaydan sonra oluştur

Gövdeyi (`## Tanım`, `## Kabul kriterleri`, `## Bağlam`) geçici bir dosyaya yaz:
```
vlad task new --project <slug> --title "<başlık>" --kind dev --body-file <geçici.md> --json
```
Çıktı: `{"id": "T20261015-01", ...}`. ID'yi kullanıcıya söyle.

## 4a. dev → çalışanı başlat

```
vlad task launch <id> --json
```
- Başarılı: görev `running`; yeni terminal sekmesi/penceresinde çalışan açılır. Kullanıcıya branch (`vlad/<id>`) ve worktree yolunu göster.
- Hata (ör. worktree/branch zaten var, launcher başarısız): görev `queued` kalır, `error` doludur. Hatayı göster; üzerine yazma, ne yapılacağını kullanıcıya sor.
- Emin değilsen önce `vlad task launch <id> --dry-run` ile çalıştırılacak komutu göster.

## 4b. research → arka plan agent'ı

1. `vlad task set <id> running --json`
2. İşi bir arka plan agent'ına ver: görev dosyası yolunu (`kb/tasks/<id>.md`) ve kabul kriterlerini ilet.
3. Önemli ara adımlarda: `vlad task log <id> "<adım>"`
4. Sonucu Markdown olarak geçici dosyaya yaz ve:
   ```
   vlad task report <id> --file <rapor.md> --json
   ```
   (görev `awaiting_approval` olur).
5. Kullanıcıya özetle; kabul ederse `vlad task set <id> done --json`.

## Kullanıcıya göster

- Taslak (onaydan önce), oluşan ID, başlatma sonucu, hata varsa tam mesajı.
- Takip için: "Durumu `/status` ile görebilirsin; çalışan bitirince sana haber verecek."
