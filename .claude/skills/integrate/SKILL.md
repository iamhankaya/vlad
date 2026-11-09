---
name: integrate
description: Bir görevin ya da pipeline fazının diff'ini entegrasyona hazırlar ve kapıyı yürütür — ön kontrol, gate, ingest-preview, kayıt dosyası yeniden üretimi, merge adımları (yalnız açık onaydan sonra). Kullan - /status'ta awaiting_approval görevin merge/kabul kararında, faz kapısında ve son kapıda.
---

# integrate — kapı yordamı

Kapı yetkisi VLAD'dadır; çalışan merge etmez. **Merge, push ve PR her zaman o görev ve o eylem için kullanıcının açık onayını ister**; onaydan önce yalnız 1–4. adımlar yapılır. Bu skill yüklenemezse kapı eylemi **durur** ve kullanıcıya söylenir; sessiz yedek yok.

**Gece modu** (`vlad mode status`) etkinse faz ve son kapı merge'ü ayrıca sorulmaz; ana branch'e push yalnız `night.push: true` ise ve gate/CI yeşil, açık P1 yokken sormadan yapılır (`night.except` sınıfları ve geri alınamaz eylemler hep sorulur); `push` yoksa push/PR yetkisi modun parçası değildir ve ayrıca sorulur; ön kontrol, gate ve ön izleme yine koşar. Codex turları: son kapıda en çok 2 düzeltme turu; 2. turdan sonra P1 sürerse gece modunda kararı VLAD verir (bir tur daha ya da bulguyla izleyerek al) ve gerekçesini sabah raporuna yazar (`second-opinion`, `/status`); sabah raporu ayrıca bayat proje özetlerini listeler (`vlad status --summary --json` → `staleSummaries`) ve `/digest` önerir. Durdurma koşulları: kritik/yüksek bulgu (yukarıdaki tur sınırı dahilinde düzeltilir), kırmızı gate/CI, ürün yönü/kanal değişikliği, geri alınamaz/veri silen eylem; bunlardan biri varsa merge etme ve kullanıcıya sor.

**Tek komut:** `vlad task close <id> [--into <dal>] [--yes] --json` aşağıdaki 1 (rapor/entegrasyon kanıtı), 2 (gate; uzak görevde `task gate`, kart ≥2 makineliyse her makine için `Gate <makine>: yeşil` satırı), 3 (merge-tree çakışma), 5 (`merge --no-ff` / uzak `task merge`, `done`, `cleanup`) adımlarını, raporun `### Kapatılan bulgular` ID'lerini (`finding set fixed --by <id>`) ve `kb commit --push`'u yürütür. `--yes` yoksa merge öncesi `confirm`'de durur ve `summary` basar; gece modu açık + gate yeşil + göreve ait açık kritik/yüksek bulgu (kayıt ya da raporun Açık noktalar'ı) yokken sormadan sürer; pipeline çatısı (son kapı) ve `designer` rolü hariç, onlar gece de sorulur. Kırmızı gate, çakışma, kirli/yanlış hedef dal ve eksik kanıtta durur (`stopped_at`, `steps`); merge sonrası adım düşerse aynı komutu yeniden koş (done görevde yalnız kalanı tamamlar). Kod push'u yapmaz. Aşağıdaki adımlar komutun yetmediği durumlar (projeler arası, bulut PR, 4. adım kayıt dosyaları, junction listesi) ve elle yürütme içindir.

## 1. Ön kontrol
- **Pipeline dev fazında (`parent` dolu):** raporun `### Test sonuçları`'nda entegrasyon branch'i merge + lint + gate sonucu var mı (Entegrasyon öncesi kontrol)? Yoksa ya da kırmızıysa (çakışma, kırmızı) merge önerme; çalışana düzeltme iste (değişiklik isteği). **Tek görevde (`parent` boş)** entegrasyon branch'i yoktur, bu kanıt istenmez; yalnız raporun test/gate sonucu ve 2. adımdaki gate koşusu aranır.
- Worktree'de junction/symlink listele (veri silme riski; cleanup'tan önce): `Get-ChildItem -Force -Recurse -Depth 4 -Directory -Exclude node_modules,.git | ? Attributes -match ReparsePoint` (kök dizindeki `node_modules` bağlantısını ayrıca `Get-Item node_modules -Force` ile kontrol et). Çıkan her bağlantıyı kullanıcıya göster. Bu liste CLI'daki F-vlad-083 düzeltmesinin yerine geçmez; ek güvencedir.

## 2. Gate
Projenin kartındaki **`gate`** komutunu (`vlad project list --json` → `gate`) ilgili worktree'de çalıştır; çıkış kodu ve kırmızıysa özetini göster. Kırmızı gate'te merge önerme. Kartta `gate` yoksa ad hoc koşu yap ve uyar: "⚠ gate tanımlı değil — kart için öneri: `vlad project set <slug> gate "<komut>"`; önbellek/şablon DB temizliği ve build'i içersin." Gate'i onaysız kendin yazma.

**Uzak makinedeki görev/faz** (config'te `machines` varken görev bir işçiye yerleşmişse): gate yerelde değil işçide, görevin kendi worktree'sinde çalışır: `vlad task gate <id> [--target integration|task] --json` (varsayılan görev türüne göre: pipeline çatısı → `integration` = çatı worktree'si; dev görevi/fazı → `task` = görevin kendisi; çıkış kodu 1 = kırmızı, 75 = makine erişilemiyor). Komut önce kb'yi işçiye senkronlar; işçi kartın `gate`'ini kendi kb klonundan okur.

**Çok makineli proje (kartın `machines` listesi ≥2):** son kapıda ve platforma özgü dosya (yol ayracı, `.ps1`/`.sh`, kabuk/süreç/dosya sistemi, `win32`/`darwin` dalı) değiştiren faz kapısında gate **her listedeki platformda** koşar; tek platformda yeşil yetmez. Beyin makinesinde yerel gate (adım 2), diğer makinelerde `vlad task gate <çatı-id> --target integration --json` (çatı o makineye pin'li değilse ilgili makinedeki faz/görev üzerinden ya da `vlad machine run` ile; erişilemiyorsa çıkış 75 → kapı bekler, kullanıcıya söyle). Her koşunun sonucunu `vlad task log <çatı-id> "Gate <makine>: yeşil|kırmızı"` ile yaz; listedeki her makine için yeşil satır yoksa merge/PR önerme. (Kanıt: T20261109-18'de Windows gate'i HostMac'i koşmadı; F-vlad-desktop-222.)

## 3. Merge ön izleme
Merge'den önce etkiyi göster: `git -C <worktree> log --oneline <taban>..HEAD`, `git -C <worktree> diff --stat <taban>...HEAD` ve çakışma ön izlemesi `git merge-tree --write-tree <hedef> vlad/<id>` (git ≥ 2.38; yoksa atla, çakışma merge sırasında `--abort` ile yakalanır). Taban: pipeline fazında `vlad/<çatı-id>`, değilse ana branch. Çakışma varsa merge önerme, rebase isteği öner. **Uzak görevde** ön izleme `vlad task merge-preview <id> [--into <dal>] --json` ile alınır (log, diff --stat, çakışmalar; yazmaz); `--into` verilmezse hedef `vlad/<çatı>` ya da kartın `default_branch`'i.

## 4. Kayıt dosyaları
Paylaşılan kayıt dosyaları (test_map, registry, `contract.ts` gibi üretilen dosyalar) çakışırsa elle satır karıştırma: üretici betikle yeniden üret, sonucu diff'te göster.

## 5. Merge adımları (yalnız açık onaydan sonra)
- **Yerel faz/görev:** `git -C <proje-yolu> branch --show-current` ile hedefi göster ve hedefin bu olduğunu açık onayla; `git status` temizse `git -C <proje-yolu> merge --no-ff vlad/<id>`. Pipeline fazında hedef `vlad/<çatı-id>` ve çatının `worktree`'sidir: `git -C <çatı worktree> merge --no-ff vlad/<id>`.
- **Son kapı (çatı → ana branch):** kaynak `vlad/<çatı-id>`, hedef projenin ana branch'i; `branch --show-current` ile hedefi göster ve onaylat, sonra `git -C <proje-yolu> merge --no-ff vlad/<çatı-id>`. Çok projeliyse her projede ayrı.
- **Uzak görev/faz:** merge yerel `git merge` ile değil, onaydan sonra `vlad task merge <id> [--into <dal>] [--message …] --json` ile işçide yapılır (`--no-ff`; **push yok**; çakışmada işçi geri alır, görev `done` yapılmaz). Hedef dalı (varsayılan `vlad/<çatı>` ya da `default_branch`) yine önce göster ve onaylat. Makine kapalıyken (çıkış 75) elle yerel merge deneme; tekrar dene ya da `/status` ile `vlad task release`.
- **Research fazında merge yoktur;** kabul = `vlad task set <id> done`.
- **Çok projeli (faz projesi ≠ çatı projesi):** çatı görevin `worktree` alanı faz projesinin entegrasyon worktree'si **değildir** (yalnız çatının kendi projesindekidir). Hedef worktree'yi çatının `integration_worktrees` alanından (`vlad task list --json`; öğe `{project, repo, branch, worktree}`) faz projesinin satırından seç; faz branch'i de faz projesinin reposundadır. Merge orada yapılır. Kapı doğrulaması, diff ve merge her projede ayrı; son kapı onayı ortak tek karardır.
- **Bulut:** merge yerel `git merge` değil GitHub PR'dır (`create_pull_request` açık onayla, sonra `merge_pull_request`); PR linkini ve base'i göster.
- **Merge başarısızsa** (çakışma): `git -C <hedef worktree> merge --abort`, hatayı göster, görevi **`done` yapma**; "değişiklik iste" ile developer'a `vlad/<çatı-id>` üzerine rebase iste.
- **Merge'süz `done` yasağı:** pipeline **dev** fazında "olduğu gibi kabul et" sunma (bağımlı fazlar değişikliği görmeden başlar); kullanıcı yine de isterse riski söyle ve bağımlıları başlatmadan önce ayrıca onay al.
- Başarılı merge sonrası `vlad task set <id> done` ve `vlad task cleanup <id>` (cleanup yalnız `done`/`cancelled` sonrası).

## Değişiklik isteği yolu
`vlad task log <id> "Değişiklik isteği: <özet>"` + `vlad task set <id> running`; çalışan açıksa `SendMessage`, kapalıysa `claude --resume <session_id>` (session_id yoksa worktree'deki tek transcript; o da yoksa taze oturum, `--continue` kullanılmaz). Research fazında agent'ı değişiklik isteğiyle yeniden çalıştır.
