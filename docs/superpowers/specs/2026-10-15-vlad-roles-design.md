# VLAD uzman roller — tasarım

- **Tarih:** 2026-10-15
- **Durum:** Kullanıcı bu tur için onay kapılarını kaldırdı ("baştan sona kendin tasarla … onay isteme"). Aşağıdaki kararlar VLAD tarafından verildi; varsayımlar §9'da açıkça listelendi.
- **Önceki kapsam:** Çekirdek spec (2026-10-15-vlad-core-design.md) §1'de "uzman roller … bu tur kapsam dışı" demişti; bu spec o maddeyi açar.

## 1. Amaç

Kullanıcının ilk vizyonu: VLAD'ın yanında Finans uzmanı, Satış & Pazarlama uzmanı, Senior Analyst, Senior Tester ve Senior Developer gibi uzmanlar. VLAD bir işi devrederken "bunu kim yapsın" sorusunu da cevaplayabilmeli; aynı tür iş her seferinde aynı bakış açısı, aynı sınırlar ve aynı çıktı biçimiyle yapılmalı.

**Başarı ölçütü:**
- `/delegate` taslağında bir rol önerilir ve görev dosyasına yazılır.
- Danışman roller (Finans, Pazarlama, Analyst) VLAD içinde, kod değiştirmeden çalışır; sonuç görev dosyasında rapor olarak kalır.
- Uygulayıcı roller (Developer, Tester) mevcut çalışan session'ı modelini değiştirmeden, çalışanın persona'sını ve sınırlarını belirler.
- Rol tanımları tek bir yerde, düz Markdown olarak durur; yeni rol eklemek kod değişikliği gerektirmez.

## 2. Kapsam

**Bu tur:**
- 5 rol: `finans`, `pazarlama`, `analyst`, `tester`, `developer`.
- `roles/<slug>.md` rol dosyaları + `schemas/role.schema.json`.
- Görev şemasına `role` alanı; `vlad task new --role <slug>`; `vlad role list`.
- Launcher prompt'una rol satırı; vlad-worker protokolüne rol adımı.
- `/delegate`, `/status`, `/digest` skill'lerinde rol desteği.

**Kapsam dışı:** rol başına izin ayarı (Claude Code `--agent` bayrağı), rollerin kendi aralarında iş devretmesi (ör. Developer bitince Tester'ı otomatik başlatmak), rol başına hafıza dosyaları, rol performans metrikleri. Rol dosyası bunlara alan açacak biçimde (frontmatter) tasarlandı. Rol başına model seçimi 2026-10-18'de eklendi (T20261018-07, §4 `model`).

## 3. Yaklaşımlar

1. **Rol dosyaları VLAD reposunda `roles/`, prompt ile enjekte (seçilen).** Rol = frontmatter (`slug`, `title`, `kind`, `summary`) + gövde (sorumluluk, yetki, kaynaklar, çıktı). Danışman rol: VLAD bir arka plan agent'ına "önce `roles/<slug>.md`'yi oku" der. Uygulayıcı rol: launcher prompt'u aynı cümleyi çalışana söyler. Claude Code'un agent kayıt mekanizmasına bağımlılık yok; tek doğruluk kaynağı; CLI şemayla doğrular.
2. **`.claude/agents/<rol>.md` olarak Claude Code agent'ları.** Danışmanlar için doğal (`subagent_type`), ama çalışan session'ı ayrı bir süreç olduğu için uygulayıcı rollere agent seçtirmek `claude --agent` gibi sürüme bağlı bayraklara dayanır; frontmatter'a VLAD alanları (`kind`) eklemek Claude Code'un ayrıştırmasıyla çakışabilir. Ayrıca ~/.claude/agents'taki genel agent'larla isim çakışması riski.
3. **Rolü yalnızca görev metnine yazmak (kod yok).** En ucuz, ama doğrulama yok, rol tanımı her görevde yeniden yazılır, tutarlılık hedefi kaybolur.

Seçim 1: tutarlılık ve doğrulama sağlar, mevcut `Launcher`/worker modelini bozmaz. Danışman rol agent'ı yine `Agent` aracıyla (genel amaçlı) başlatılır; rol dosyası prompt'un ilk adımıdır.

## 4. Rol dosyası

`roles/<slug>.md`:
```markdown
---
slug: tester
title: Senior Tester
kind: executor          # advisory | executor
summary: Test stratejisi kurar, eksik testleri yazar, hataları kanıtla raporlar.
---

## Sorumluluk
## Yetki
## Kaynaklar
## Çıktı
```
- `kind: advisory` → yalnızca `research` görevlerinde kullanılır; kod/repo değiştirmez.
- `kind: executor` → yalnızca `dev` görevlerinde kullanılır; çalışan session'ı olarak koşar.
- Şema: `slug` (`^[a-z][a-z0-9-]*$`, dosya adıyla aynı), `title`, `kind`, `summary` zorunlu; `additionalProperties: false`.
- Opsiyonel `model` (2026-10-18): rolün çalışanının/agent'ının Claude modeli (ör. `sonnet`, `opus`, `claude-sonnet-5-5`). Desen `^[A-Za-z0-9][A-Za-z0-9._\[\]-]*$`; boş, boşluklu, tırnaklı veya `-` ile başlayan değer şemadan geçmez (rol uyarı olur). Yoksa varsayılan model kullanılır. Kullanım limiti için uygulayıcı ve danışman rollerin hepsi `model: sonnet` taşır; VLAD'ın kendi session'ı varsayılan modelde (Opus) kalır.
- Gövdede dört bölüm zorunlu değildir (şema frontmatter'ı doğrular), ama 5 başlangıç rolü dördünü de taşır.

### Başlangıç rolleri

| slug | title | kind | Temel aldığı | Özet |
|---|---|---|---|---|
| `finans` | Finans Uzmanı | advisory | — | Maliyet, fiyatlandırma, gelir modeli, bütçe; varsayımları ve rakamların kaynağını açıkça yazar. |
| `pazarlama` | Satış & Pazarlama Uzmanı | advisory | — | Hedef kitle, konumlandırma, kanal, mesaj, lansman; iddiaları kaynakla destekler. |
| `analyst` | Senior Analyst | advisory | planner, explorer | Gereksinim analizi, kod/doküman incelemesi, seçenek karşılaştırması, risk; koddan doğrular. |
| `tester` | Senior Tester | executor | reviewer | Test stratejisi, eksik testler, hata avı; üretim kodunu değiştirmez, hatayı kanıtlayan test + rapor. |
| `developer` | Senior Developer | executor | implementer | Özellik/bug/refactor; TDD, review, kabul kriterlerini tek tek karşılar. |
| `devops` | Senior DevOps Engineer | executor | — | Dağıtım/CI/altyapı betikleri, runbook; dağıtımı temiz ortamda prova eder (`### Prova matrisi`, `### Bulunan hatalar`, `### Prova edilemeyenler`); gerçek sunucuya dağıtım yok (T20261022-59, pipeline spec §17). |

**Ekip kuralları (T20261022-60, pipeline spec §18):** developer `sözleşme` fazı + test itirazı (`vlad task ask`) + UI öz-kontrolü; tester sözleşmeden kabul testi, gerçek fixture, ad alanı; architect `### Paylaşılan dosyalar ve ad alanları`; analyst/architect gerçek yanıt örneği; designer ara `denetim`.

### Sistem tasarımı ve `exposure` (2026-10-20, T20261020-53)

Sistem tasarımı ayrı bir role bölünmez; `architect`'e `### Sistem tasarımı` bölümü olarak eklenir. Derinliği proje kartının opsiyonel `exposure` alanı belirler:

| `exposure` | `### Sistem tasarımı` |
|---|---|
| `local` | Kısa: süreç modeli, veri/dosya saklama, yetkiler, kurtarma, dağıtım. |
| `network` | `local` ile `internet` arası: veri akışı, yetki/kimlik doğrulama, depolama, hata senaryoları; ölçek/maliyet gerekiyorsa. |
| `internet` | Tam: veri akışı, depolama/cache, ölçeklenme, gerçek zamanlı topoloji, auth/güvenlik, altyapı, hata senaryoları, maliyet. |

İş sisteme etki etmiyorsa bölüm tek satır gerekçedir. Alan boşsa architect tahmin etmez; `### Açık noktalar`'a "exposure belirsiz" yazar. `analyst` spec'e kısa `### Sistem etkisi` ekler: `özellik` döngüsünde (architect fazı yok) sistem tasarımının yerini tutar, `tam` döngüsünde architect'e girdi olur ve görev seviyesindeki istisnaları kapsar.

**İş akışına bağ (T20261020-56).** `/delegate` döngü seçerken kartın `exposure` değerini işaret olarak kullanır: `internet`/`network` projede iş auth, veri modeli/saklama, altyapı, dışa açık yüzey ya da ölçeği etkiliyorsa en az `özellik` önerilir; `kısa`/`tek` seçilirse taslakta gerekçe yazılır. Taslaklar `exposure` değerini gösterir; boşsa "exposure belirsiz" uyarısı çıkar ve kullanıcıya sorulur. `tester`, kabul/karakterizasyon fazında girdideki `### Sistem tasarımı` / `### Sistem etkisi` hata senaryolarını test adayı olarak okur; karşılamadıklarını kapsam tablosunda/açık noktalarda gerekçelendirir. `developer`, girdide sistem tasarımı varsa kapanış raporunun `### Kabul kriterleri` bölümüne "sistem tasarımına uyum" maddesi ekler (uyuldu/sapıldı + neden); yoksa atlar.

**`exposure` ≠ `local_only`.** `local_only` (+ `local_only_reason`) "bulutta derlenip çalıştırılabilir mi?" sorusunu cevaplar (ör. WPF/Windows) ve yalnızca bulut launcher'ını etkiler. `exposure` "sisteme kim erişir?" sorusunu cevaplar ve yalnızca mimari/spec çıktılarını ölçekler. İki alan bağımsızdır (yerel çalışan bir proje internete açık olabilir, bulutta derlenen bir proje `local` olabilir). `exposure` stack'ten tahmin edilmez: `/scan` yeni projede kullanıcıya sorar, mevcut kartta boşsa "exposure belirsiz" diye listeler.

Ortak sınırlar (her rol dosyasında tekrarlanır, çünkü agent yalnızca kendi rol dosyasını okur):
- Doğruluk kaynağı görev dosyası; yazma yalnızca `vlad` CLI ile.
- Dışa etkili eylem (push, PR, mail, ödeme, yayın) yok; `autonomy: pr` dışında push yok (vlad-worker kuralı).
- Tahmin yürütmez; bilinmeyeni "varsayım" diye işaretler.
- Danışmanlar: web araştırması yapabilir (WebSearch/WebFetch), kaynak linki verir; kullanıcının projelerinde dosya yazmaz.

## 5. Görev şeması ve CLI

- `schemas/task.schema.json`: `role: string | null` (opsiyonel).
- `vlad task new … --role <slug>`:
  - rol dosyası yoksa hata: `rol bulunamadı: <slug>; mevcut: …`;
  - `advisory` rol + `--kind dev` veya `executor` rol + `--kind research` → hata: `rol <slug> (<kind>) <task kind> görevinde kullanılamaz`.
- `vlad role list [--json]` → `{ roles: [{slug,title,kind,summary,skills,model,file}], warnings }` (`model` alanı yoksa `null`) (bozuk rol dosyası uyarı olur, liste düşmez — `project list` ile aynı kalıp).
- `vlad task list` / `status --json` çıktısı `role` alanını zaten taşır (frontmatter'ın tamamı döner).
- `buildPrompt(taskFile, autonomy, roleFile?)`: rol varsa prompt'a eklenir: `Rolün: <title>. Göreve başlamadan önce \`<roleFile>\` dosyasını oku ve oradaki sorumluluk, yetki ve çıktı kurallarına uy.` `launchTask` rolü görev dosyasından okur; rol dosyası artık yoksa launch hata verir (görev `queued` kalır, `error` dolu — mevcut hata yolu).
- Rolün `model`'i doluysa `launchTask` onu `LaunchRequest.model` olarak geçirir; launcher script'i `claude --model '<model>' $p` üretir (değer tek tırnakla quote'lanır ve launcher'da desenle yeniden doğrulanır; geçersizse script yazılmaz). Model yoksa veya görev rolsüzse bugünkü gibi `claude $p`.

## 6. Akışlar

**/delegate:**
1. `vlad role list --json` ile rolleri al.
2. Taslakta **Rol:** satırı: işe en uygun rolü öner (gerekçesiyle tek cümle) veya "rol yok". `kind` uyumunu gözet (research → advisory, dev → executor).
3. `vlad task new … --role <slug>`.
4. research + rol: arka plan agent'ının prompt'u: "Rol dosyan: `<VLAD_HOME>/roles/<slug>.md` — önce onu oku. Görev: `kb/tasks/<id>.md`." Agent sonucu döndürür; VLAD `vlad task report` ile yazar (mevcut akış). Agent rolün `model`'iyle başlatılır (Agent aracının `model` parametresi); rolsüz/boşsa varsayılan.
5. dev + rol: `vlad task launch` (prompt rolü, script rolün `model`'ini taşır).

**vlad-worker:** adım 1'e: frontmatter'da `role` doluysa `<VLAD_HOME>/roles/<role>.md`'yi oku; rolün yetki sınırları autonomy kurallarıyla birlikte geçerlidir; çelişkide **daha kısıtlayıcı** olan uygulanır.

**/status ve /digest:** tabloda ve günlük maddesinde rol başlığı gösterilir (ör. "Senior Tester: …").

## 7. Hata durumları

| Durum | Davranış |
|---|---|
| Bilinmeyen rol (`task new`) | CLI hata, görev oluşmaz |
| Rol/kind uyumsuz | CLI hata, görev oluşmaz |
| Rol dosyası görev oluştuktan sonra silindi | `launch` hata verir, görev `queued` + `error` |
| Bozuk rol dosyası | `role list` uyarı; `task new --role` o rol için hata |
| Rolsüz görev | Bugünkü davranış aynen |

## 8. Test

- `roles` store: listeleme, şema doğrulama, bozuk dosyada uyarı, slug–dosya adı uyuşmazlığı.
- `task new --role`: geçerli rol yazılır; bilinmeyen rol ve kind uyumsuzluğu hata.
- `buildPrompt`: rol satırı var/yok; `launchTask` rol dosyası yoksa `queued` + `error`.
- CLI: `role list --json`, `task new --role`.
- Repo'daki 5 rol dosyası şemadan geçer (gerçek `roles/` üzerinde test).

## 9. Varsayımlar (kullanıcıya sorulmadan verilen kararlar)

1. İlk tur 5 rolün hepsi; öncelik sırası yok, çünkü rol eklemek yalnızca bir Markdown dosyası.
2. Satış ve Pazarlama tek rol (`pazarlama`); ayrılması gerekirse yeni dosya.
3. Danışman roller kullanıcının projelerinde dosya yazmaz; çıktıları yalnızca görev raporu.
4. Tester üretim kodunu değiştirmez; hatayı kanıtlayan test ve rapor yazar, düzeltmeyi Developer görevine bırakır.
5. Rol seçimi zorunlu değil; rolsüz görev bugünkü gibi çalışır.
6. Rol dosyaları Türkçe (VLAD dili); slug'lar ASCII.
