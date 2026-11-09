---
name: bulgu-tarama
description: Bir ya da birkaç projenin açık düşük/bilgi (isteğe bağlı orta) bulgularını kodla karşılaştırıp gruplar, kör ikinci gözle doğrular ve güvenli olanları toplu kapatır; gri olanları kullanıcıya sorar. Kullan - kullanıcı "/bulgu-tarama", "eski bulguları tara/temizle", "düşük bulguları kapat" dediğinde ya da bir projede bulgu yığını biriktiğinde.
---

# /bulgu-tarama — bulgu hijyeni taraması

VLAD ana oturumu yürütür. Kb'ye **yalnız `vlad` CLI** ile yazılır (elle düzenleme yok). Karar kuralları D-genel-008 (bulgu döngüsü) ve D-genel-015 (kapı yetkisi) ile uyumludur; kod değiştirmez.

## Girdi

- **Proje(ler):** bir ya da birden çok slug (belirtilmezse sor).
- **Önem:** varsayılan `düşük,bilgi`; kullanıcı isterse `orta` eklenir. `kritik`/`yüksek` hiç taranmaz.
- **Yaş süzgeci (isteğe bağlı):** `--older-than <gün>`.

Aday listesi: `vlad finding list --project <slug> --state open,deferred --severity <önemler> [--older-than <gün>] [--source <görev>] --json` (ayrıntı gövdede `detail`).

## Adım 1 — Öneri

1. Bulguları dosya/alan/konu ile grupla (başlık ve ayrıntıdaki yol/modül adlarından).
2. Grup başına bir **arka plan agent'ı** (`sonnet`) başlat; agent her bulguyu projenin güncel koduyla (`git log`, `grep`, dosya okuma) karşılaştırır ve bulgu başına tek öneri döndürür:
   - `kapat-fixed` — kodda karşılığı yok ya da sonradan düzeltilmiş. **Kanıt zorunlu:** commit hash'i veya `dosya:satır`.
   - `kapat-wontfix` — etkisiz/kabul edilebilir. **Gerekçe zorunlu.**
   - `birleştir` — başka bir bulguyla yinelenen; hedef `F-…` ID'si.
   - `kalsın` — hâlâ geçerli ya da emin değil.
3. Agent'lar kb'ye yazmaz; çıktıları **taslaktır**.

## Adım 2 — İkinci göz (kör)

`kapat-fixed`, `kapat-wontfix` ve `birleştir` önerilen **her** bulgu için ayrı bir bağımsız subagent (`sonnet`) başlat. Ona yalnız bulgu kaydı (başlık, ayrıntı, önem) ve kod verilir; **ilk agent'ın kararı, gerekçesi ve kanıtı verilmez**. Kendi kararını (`fixed`/`wontfix`/`yinelenen`/`kalsın` + kanıt/gerekçe) döndürür.

## Adım 3 — Karar

VLAD iki gözü karşılaştırır. **Otomatik kapatır yalnız şu durumda:** iki göz aynı sonuçta **ve**
- `fixed` için somut kod/commit kanıtı var (VLAD kanıtı kendisi doğrular: `git show`/dosya oku), ya da
- `wontfix` için bulgunun önemi `düşük` veya `bilgi`.

**Gri** (kullanıcıya grup tablosuyla sorulur: ID, başlık, iki gözün kararı, kanıt): iki göz ayrıştı; `orta` önemde `wontfix`; kanıt zayıf/dolaylı. Tablo grup başına verilir, kullanıcı grup ya da madde bazında karar verir.

**Asla otomatik kapatılmaz** (taramaya girse bile kullanıcıya sorulur ya da `kalsın`):
- `kritik` ve `yüksek` önemli bulgular;
- güvenlik etkili olanlar (auth, yetki, sır, imza, oturum, veri silme);
- karar ile ertelenmiş/kabul edilmiş risk (`deferred` + `D-…` atfı; kararı `vlad decision list --project <slug> --all --json` ile doğrula);
- kullanıcının açtığı ya da bir kullanıcı adımını bekleyen bulgu (ör. "kullanıcı teyidi/anahtar/hesap bekliyor").

## Adım 4 — Kayıt

1. Aynı sonuçlu bulguları **toplu** kapat (hepsi-ya-hiç; bir ID hatalıysa hiçbiri yazılmaz, önce düzelt):
   ```
   vlad finding set <id...> fixed --reason "bulgu-tarama <tarih>: <gerekçe + commit/dosya:satır>" [--by <görev>] --json
   vlad finding set <id...> wontfix --reason "bulgu-tarama <tarih>: <gerekçe>" --json
   ```
   Birleştirilenler: `vlad finding set <id...> wontfix --reason "yinelenen: F-…"`. Gerekçe bulgu dosyasının `## Kapanış` bölümüne yazılır.
2. Günlük: `vlad journal append` ile proje başına özet (kapanan sayı, sınıflar `fixed/wontfix/yinelenen`, kullanıcıya sorulanlar ve sonucu, kalanlar).
3. `vlad project refresh <slug>` (kartın açık bulgu bloğu; `finding set` zaten tazeler, doğrula).
4. `vlad kb commit "bulgu-tarama <tarih>: <özet>" --push`.

**Geri alma:** `vlad finding set <id> open` (`## Kapanış` geçmişi kalır).

## Kurallar

- Emin olmadığın bulgu `kalsın`; kapatmak için kanıt gerekir, kalması için gerekmez.
- Orta bulgu yalnız kullanıcı istediğinde taranır ve `wontfix`'i her zaman gridir.
- Kullanıcıya sonuçta kısa tablo ver: proje, taranan, otomatik kapanan (fixed/wontfix/yinelenen), sorulan, kalan.
