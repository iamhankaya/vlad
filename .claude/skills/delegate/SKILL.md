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
- Uzman rolleri al:
  ```
  vlad role list --json
  ```
  `{"roles":[{ "slug", "title", "kind", "summary", "file", "skills" }], ...}`. `advisory` roller (finans, pazarlama, analyst, architect) yalnızca `research`, `executor` roller (developer, tester, designer) yalnızca `dev` görevinde kullanılır.

## 2. Döngüyü seç

İşin boyutuna göre bir döngü seç (tasarım: `docs/superpowers/specs/2026-10-16-vlad-pipeline-design.md` §3). `→` sıra, `∥` paralel:

| Döngü | Ne zaman | Fazlar |
|---|---|---|
| `tam` | Sıfırdan proje/alt sistem; yeni arayüz/şema; gereksinim belirsiz | analyst:spec → architect:plan → (tester:kabul ∥ developer:uygulama) → tester:doğrulama |
| `özellik` | Mevcut projede net bir özellik; birkaç modül | analyst:spec → (tester:karakterizasyon+kabul ∥ developer:uygulama) → tester:doğrulama |
| `kısa` | Tek modülde değişiklik, net gereksinim, görünür davranış değişiyor | developer:uygulama → tester:doğrulama |
| `tek` | Küçük düzeltme, belge, bakım | tek görev (bugünkü akış, rol opsiyonel) |

**Arayüz varsa designer fazlarını ekle** (kullanıcıya görünen UI değişiyorsa; yoksa ekleme):
- `tam` / `özellik`: spec'ten sonra `tasarım` (designer, dev, bağımlılık: spec); `tam`'da `plan` ve `özellik`'te tester/developer fazları `tasarım`'a bağlanır.
- Üç döngüde de `doğrulama` ile paralel `denetim` (designer, dev, bağımlılık: doğrulamayla aynı). `kısa`'da yalnızca `denetim` eklenir.

İşaretler: sıfırdan mı; dokunulan dosya/modül sayısı; arayüz/şema değişikliği; gereksinimin netliği; kullanıcıya görünür davranış.
- İşaretler aynı döngüyü gösteriyorsa sen seç; taslağa tek cümlelik gerekçe yaz.
- İşaretler çelişiyorsa veya gereksinim belirsizse taslaktan önce **kullanıcıya sor**: iki aday döngüyü artı/eksiyle göster (ör. "`özellik`: + spec ile kapsam netleşir, − bir faz ve bir kapı fazla; `kısa`: + hızlı, − gereksinim belirsizliği uygulamaya kalır") ve seçimini bekle.
- Küçük işe tam departman çalıştırma; şüphede küçük döngüyü öner.

`tek` → adım 3a. Diğerleri (pipeline) → adım 3b.

## 3a. Taslak (`tek`)

Türü belirle:
- `dev`: repoda kod değişikliği → ayrı, görünür çalışan session'ı (worktree + `vlad/<id>` branch'i).
- `research`: kod değiştirmeyen kısa iş (araştırma, özet, inceleme) → VLAD içinde arka plan agent'ı.

Kullanıcıya şunu göster:
```markdown
**Proje:** <slug>   **Tür:** dev|research   **Yetki:** <autonomy, karttan>
**Döngü:** tek — <gerekçe, tek cümle>
**Rol:** <title> (`<slug>`) — <neden bu rol, tek cümle> | rol yok
**Başlık:** <kısa başlık>

## Tanım
<ne yapılacak, neden>

## Kabul kriterleri
- [ ] <test edilebilir kriter>

## Bağlam
<ilgili kararlar, dosyalar, kısıtlar; kaynak ID'leriyle>
```
Rol önerisi: işin doğasına en uygun rolü seç (ör. test yazma/hata avı → `tester`, maliyet/fiyat → `finans`, gereksinim/kod inceleme → `analyst`); türüyle uyumlu olmalı. Uygun rol yoksa "rol yok" yaz; rolsüz görev bugünkü gibi çalışır.

Sonunda sor: "Bu görevi oluşturup başlatayım mı?"

## 3b. Taslak (pipeline: `tam`, `özellik`, `kısa`)

Kullanıcıya şunu göster:
```markdown
**Proje:** <slug>   **Yetki:** <autonomy, karttan>
**Döngü:** <tam|özellik|kısa> — <gerekçe, tek cümle>
**Başlık:** <kısa başlık>

## Tanım
<ne yapılacak, neden>

## Kabul kriterleri
- [ ] <test edilebilir kriter>

## Bağlam
<ilgili kararlar, dosyalar, kısıtlar; kaynak ID'leriyle>

### Fazlar
| # | Faz | Rol | Tür | Bağımlılık |
|---|---|---|---|---|
| 1 | spec | Senior Analyst (`analyst`) | research | — |
| 2 | kabul | Senior Tester (`tester`) | dev | 1 |
| 3 | uygulama | Senior Developer (`developer`) | dev | 1 |
| 4 | doğrulama | Senior Tester (`tester`) | dev | 2, 3 |

### Kapılar
- Her fazın sonunda onay (`/status`): research fazı raporu kabul edilir, dev fazı entegrasyon branch'ine (`vlad/<çatı-id>`) merge edilir. Bağımlı fazlar ancak bundan sonra başlar.
- Son kapı: tüm fazlar bitince `vlad/<çatı-id>` ana branch'e merge (veya push + PR) — ayrıca onaylanır.
```
Örnek tablo `özellik` döngüsüdür (karakterizasyon ve kabul tek tester fazında). Faz adları: `spec`, `tasarım`, `plan`, `kabul`, `karakterizasyon`, `uygulama`, `doğrulama`, `denetim`, `danışma`. Rol başlıklarını `vlad role list --json`'dan al. Faz tablosu döngü şablonundan gelir; işe göre faz ekleyip çıkarabilirsin (gerekçesiyle).

Sonunda sor: "Bu pipeline'ı oluşturup ilk fazları başlatayım mı?" Bu onay fazların başlatılmasını da kapsar; merge kapıları yine ayrı ayrı sorulur.

## 4. Onaydan sonra oluştur

**`tek`:** Gövdeyi (`## Tanım`, `## Kabul kriterleri`, `## Bağlam`) geçici bir dosyaya yaz:
```
vlad task new --project <slug> --title "<başlık>" --kind <dev|research> [--role <slug>] --body-file <geçici.md> --json
```
Çıktı: `{"id": "T20261015-01", ...}`. ID'yi kullanıcıya söyle. Rol bulunamazsa veya türle uyumsuzsa CLI hata verir ve görev oluşmaz; hatayı göster, taslağı düzelt. Sonra adım 5a (dev) veya 5b (research).

**Pipeline:**
1. Çatı görev — taslağın gövdesi (faz tablosu ve kapılar `## Bağlam` altında `###` başlıklarıyla):
   ```
   vlad task new --project <slug> --title "<başlık>" --kind pipeline --body-file <çatı.md> --json
   ```
   Çatı görev rol almaz ve `launch` edilmez; durumunu sen yönetirsin (ilk faz başlayınca `running`, tüm fazlar `done` olunca `awaiting_approval`, son kapıdan sonra `done`).
2. Fazlar, tablodaki **sırayla**. Her faz için gövde: `## Tanım` (fazın payı), `## Kabul kriterleri` (rolün `## Çıktı`'sı ve işin kriterlerinden bu faza düşenler), `## Bağlam` (çatı ID'si; "girdi: bağımlı olduğun görevlerin `## Kapanış raporu`"). Bağımlılık yalnızca **daha önce oluşturulmuş** fazlara verilir; tablodaki numaraları oluşan ID'lere çevir:
   ```
   vlad task new --project <slug> --title "<başlık> — <faz>" --kind <dev|research> --role <slug> --parent <çatı-id> [--depends-on <id1,id2>] --phase <faz> --body-file <faz.md> --json
   ```
   Bir faz hata verirse dur, hatayı göster; oluşanları kullanıcıya söyle (gerekirse `cancelled` yapılır).
3. Başlatılabilir fazları al:
   ```
   vlad task ready --parent <çatı-id> --json
   ```
   `{"tasks":[...]}` — `queued` olup tüm bağımlılıkları `done` olanlar. Her birini başlat: dev → 5a, research → 5b, plan fazı → 6.
4. Kullanıcıya ağacı göster: çatı ID'si, her faz (ID, faz, rol, bağımlılık), hangilerinin başlatıldığı.

## 5a. dev → çalışanı başlat

Önce bildirim kanalını hazırla: `ListAgents` çalıştır, ilk satırdaki `This session is <ad>` adını al ve `vlad session register <ad>` çalıştır (açılışta yapıldıysa da tekrar etmek zararsızdır). Böylece çalışan bitince sana `SendMessage` atabilir.

Sonra çalışanı başlat. Bu komutu **PowerShell aracıyla** çalıştır, Bash aracıyla değil. Pencere WMI (`Win32_Process.Create`) ile açılır ve bu çağrı Bash aracından çalıştırılınca başarısız olur (kod 8):

```
vlad task launch <id> --json
```
- Başarılı: görev `running`; yeni terminal sekmesi/penceresinde çalışan açılır. Kullanıcıya branch (`vlad/<id>`) ve worktree yolunu göster.
- Pipeline fazı (`parent` dolu): ilk fazda entegrasyon branch'i `vlad/<çatı-id>` ve worktree'si (`<worktreeDir>/<çatı-id>`) açılır, çatı `running` olur; fazın branch'i entegrasyon branch'inden açılır. Kullanıcıya ikisini de göster.
- Hata (ör. worktree/branch zaten var, launcher başarısız): görev `queued` kalır, `error` doludur. Hatayı göster; üzerine yazma, ne yapılacağını kullanıcıya sor.
- `--dry-run` önizleme değildir: worktree + branch oluşturur ve görevi terminal açmadan `running` yapar (yalnızca test içindir). Bu yüzden "önce dry-run ile göster" diye kullanma.

### 5a-cloud. Bulut modu (VLAD bulutta çalışıyorsa)

`vlad task launch` komutu `launcher: cloud` ise veya `auto` + `CLAUDE_CODE_REMOTE=true` ise bulut modundadır. Yerel worktree/terminal açılmaz; komut `create_session` argümanlarını JSON olarak döner ve görevi `running` yapar. Akış:

1. `vlad task launch <id> --json` çalıştır. Hata (kartta `repo` yok, `local_only`, dev değil) → görev `queued` kalır, `error` doludur; hatayı göster, ne yapılacağını sor.
2. `integration.needs_remote_create` doğruysa entegrasyon branch'ini `integration.branch` adıyla remote'ta oluştur (GitHub MCP `create_branch`, repo'nun varsayılan branch'inden; kullanıcı onayı pipeline taslak onayında alınmıştır). Pipeline'ın sonraki fazlarında bu alan `false` döner.
3. `create_session` çağır: `source_url`, `source_revision` (null ise repo'nun varsayılan branch'i), `outcome_branch`, `model`, `title`, `tags`, `permission_mode`, `prompt` alanlarını çıktıdan aynen ver.
4. Dönen session ID'sini yaz: `vlad task session <id> <session_id>`. `create_session` başarısızsa `vlad task set <id> failed` (görev `running`'den `queued`'a dönemez); hatayı göster, yeni görev öner.
5. Bildirim yoktur; izleme `/status` ile yapılır (`get_session`/`list_events` → `vlad task ingest`). Kullanıcıya session'ı, branch'i (`vlad/<id>`) ve base'i göster.

Görev ID'leri bulutta günlük `51`'den başlar (yerel VLAD ile çakışmaz). Tasarım: `docs/superpowers/specs/2026-10-20-vlad-cloud-design.md`.

## 5b. research → arka plan agent'ı

1. `vlad task set <id> running --json`
2. İşi bir arka plan agent'ına ver: görev dosyası yolunu (`kb/tasks/<id>.md`) ve kabul kriterlerini ilet. Görevin rolü varsa prompt şu cümleyle başlar: "Rolün: <title>. Önce `<rol file>` dosyasını oku ve oradaki sorumluluk, yetki ve çıktı kurallarına uy." (`file`, `vlad role list --json` çıktısından). Rolün `skills` listesi doluysa ardından: "İşe başlamadan şu skill'leri yükle: `<a>`, `<b>`. Yüklenemeyen olursa raporda belirt." Pipeline fazıysa ekle: "Önce bağımlı olduğun görevlerin `## Kapanış raporu` bölümünü oku: `kb/tasks/<dep-id>.md` …" (görevin `depends_on`'u). Agent sonucu Markdown olarak döndürür; dosya yazmaz. Arka plan agent'ını rolün `model`'iyle başlat (Agent aracının `model` parametresi; değer `vlad role list --json` çıktısından); rolsüz/boşsa varsayılan.
3. Önemli ara adımlarda: `vlad task log <id> "<adım>"`
4. Sonucu Markdown olarak geçici dosyaya yaz ve:
   ```
   vlad task report <id> --file <rapor.md> --json
   ```
   (görev `awaiting_approval` olur).
5. Kullanıcıya özetle; kabul ederse `vlad task set <id> done --json`. Pipeline fazıysa bu bir kapıdır: kabulden sonra `/status`'taki pipeline ilerletme adımını uygula (hazır fazları başlat).

## 6. Plan fazı: yaz–eleştir

`plan` fazı (architect, research) tek görev içinde sırayla yürür; "birlikte oturma" budur (spec §7):
1. `vlad task set <id> running --json`
2. **Taslak:** architect rolüyle arka plan agent'ı (5b'deki rol, skill ve `depends_on` cümleleriyle; girdi spec fazının raporu). Rolün `## Çıktı` başlıklarıyla taslak plan döndürür. Taslağı geçici dosyada tut; `vlad task log <id> "Plan taslağı hazır"`.
   Bu adımdaki tüm arka plan agent'larını (taslak, eleştiri, son plan) kullandıkları rolün `model`'iyle başlat (Agent aracının `model` parametresi); rolsüz/boşsa varsayılan.
3. **Eleştiri:** iki arka plan agent'ı paralel — biri `roles/developer.md`, biri `roles/tester.md` rol dosyasıyla. Prompt: spec raporu + taslak plan; "Rol dosyasından yalnızca rolün bakış açısını al; Yetki, iş akışı ve commit kuralları bu görevde geçerli değil. Kendi rolünün gözüyle eleştir: uygulanabilirlik/test edilebilirlik, eksik arayüz, belirsiz görev, risk; madde madde. Kod yazma, dosya değiştirme, skill yükleme." Her biri için `vlad task log <id> "<Developer|Tester> eleştirisi: <kısa özet>"`.
4. **Son plan:** architect agent'ına taslak + iki eleştiriyi ver; son planı ve `### Eleştiriler ve nasıl ele alındı` bölümünü yazdır.
5. Rapora yalnızca son plan girer (ara ürünler log'da kalır): `vlad task report <id> --file <plan.md> --json`, sonra 5b adım 5.

## 7. Danışman yan görevleri

Finans veya pazarlama herhangi bir fazdan (taslakta ya da fazlar sürerken) danışılabilir. Kullanıcıya yan görevi kısa bir taslakla göster, onay al:
```
vlad task new --project <slug> --title "<başlık> — danışma: <konu>" --kind research --role <finans|pazarlama> --parent <çatı-id> --phase danışma --body-file <danışma.md> --json
```
Bağımlılık verilmez; hemen 5b ile yürüt. Sonucu ilgili fazın bağlamına ekle: faz henüz oluşturulmadıysa özetini o fazın `## Bağlam`'ına yaz; oluşturulduysa `vlad task log <faz-id> "Danışma <yan-id>: <özet> — raporuna bak"`. Çalışanlar kardeş görevleri de okur.

## 8. Hafızayı commit'le

Görev oluşturulup başlatıldıktan (veya research raporu yazıldıktan) sonra:
```
vlad kb commit "delegate: <id> <başlık>" --push --json
```
Pipeline'da `<id>` çatı ID'sidir.

## Kullanıcıya göster

- Taslak (onaydan önce), oluşan ID'ler (pipeline'da ağaç), başlatma sonucu, hata varsa tam mesajı.
- Takip için: "Durumu `/status` ile görebilirsin; çalışan bitirince sana haber verecek."
