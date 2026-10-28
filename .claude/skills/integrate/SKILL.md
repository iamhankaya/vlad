---
name: integrate
description: Bir görevin ya da pipeline fazının diff'ini entegrasyona hazırlar ve kapıyı yürütür — ön kontrol, gate, ingest-preview, kayıt dosyası yeniden üretimi, merge adımları (yalnız açık onaydan sonra). Kullan - /status'ta awaiting_approval görevin merge/kabul kararında, faz kapısında ve son kapıda.
---

# integrate — kapı yordamı

Kapı yetkisi VLAD'dadır; çalışan merge etmez. **Merge, push ve PR her zaman o görev ve o eylem için kullanıcının açık onayını ister**; onaydan önce yalnız 1–4. adımlar yapılır. Bu skill yüklenemezse kapı eylemi **durur** ve kullanıcıya söylenir; sessiz yedek yok.

## 1. Ön kontrol
- Raporun `### Test sonuçları`'nda entegrasyon branch'i merge + lint + gate sonucu var mı (Entegrasyon öncesi kontrol)? Yoksa ya da kırmızıysa (çakışma, kırmızı) merge önerme; çalışana düzeltme iste (değişiklik isteği).
- Worktree'de junction/symlink listele (veri silme riski; cleanup'tan önce): `Get-ChildItem -Force -Recurse -Directory | ? Attributes -match ReparsePoint`. Çıkan her bağlantıyı kullanıcıya göster. Bu liste CLI'daki F-vlad-083 düzeltmesinin yerine geçmez; ek güvencedir.

## 2. Gate
Projenin kartındaki **`gate`** komutunu (`vlad project list --json` → `gate`) ilgili worktree'de çalıştır; çıkış kodu ve kırmızıysa özetini göster. Kırmızı gate'te merge önerme. Kartta `gate` yoksa ad hoc koşu yap ve uyar: "⚠ gate tanımlı değil — kart için öneri: `vlad project set <slug> gate "<komut>"`; önbellek/şablon DB temizliği ve build'i içersin." Gate'i onaysız kendin yazma.

## 3. Ingest-preview
Merge'den önce etkiyi göster: `git -C <worktree> log --oneline <taban>..HEAD`, `git -C <worktree> diff --stat <taban>...HEAD` ve çakışma ön izlemesi `git merge-tree --write-tree <hedef> vlad/<id>`. Taban: pipeline fazında `vlad/<çatı-id>`, değilse ana branch. Çakışma varsa merge önerme, rebase isteği öner.

## 4. Kayıt dosyaları
Paylaşılan kayıt dosyaları (test_map, registry, `contract.ts` gibi üretilen dosyalar) çakışırsa elle satır karıştırma: üretici betikle yeniden üret, sonucu diff'te göster.

## 5. Merge adımları (yalnız açık onaydan sonra)
- **Yerel faz/görev:** `git -C <proje-yolu> branch --show-current` ile hedefi göster ve hedefin bu olduğunu açık onayla; `git status` temizse `git -C <proje-yolu> merge --no-ff vlad/<id>`. Pipeline fazında hedef `vlad/<çatı-id>` ve çatının `worktree`'sidir: `git -C <çatı worktree> merge --no-ff vlad/<id>`.
- **Çok projeli (faz projesi ≠ çatı projesi):** hedef worktree'yi çatının `integration_worktrees` alanından (`vlad task list --json`) faz projesinin satırından seç; merge orada yapılır. Kapı doğrulaması, diff ve merge her projede ayrı; son kapı onayı ortak tek karardır.
- **Bulut:** merge yerel `git merge` değil GitHub PR'dır (`create_pull_request` açık onayla, sonra `merge_pull_request`); PR linkini ve base'i göster.
- **Merge başarısızsa** (çakışma): `git merge --abort`, hatayı göster, görevi **`done` yapma**; "değişiklik iste" ile developer'a `vlad/<çatı-id>` üzerine rebase iste.
- **Merge'süz `done` yasağı:** pipeline **dev** fazında "olduğu gibi kabul et" sunma (bağımlı fazlar değişikliği görmeden başlar); kullanıcı yine de isterse riski söyle ve bağımlıları başlatmadan önce ayrıca onay al.
- Başarılı merge sonrası `vlad task set <id> done` ve `vlad task cleanup <id>` (cleanup yalnız `done`/`cancelled` sonrası).

## Değişiklik isteği yolu
`vlad task log <id> "Değişiklik isteği: <özet>"` + `vlad task set <id> running`; çalışan açıksa `SendMessage`, kapalıysa `claude --resume <session_id>` (yoksa `--continue`). Research fazında agent'ı değişiklik isteğiyle yeniden çalıştır.
