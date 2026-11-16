# integrate — kapilar-ek (reference)

> `SKILL.md`'den taşındı; metin aynen korunmuştur. SKILL.md'deki tetikleyici satır bu dosyayı okumanı söyler.

## Junction listesi (Windows)

- Worktree'de junction/symlink listele (veri silme riski; cleanup'tan önce): `Get-ChildItem -Force -Recurse -Depth 4 -Directory -Exclude node_modules,.git | ? Attributes -match ReparsePoint` (kök dizindeki `node_modules` bağlantısını ayrıca `Get-Item node_modules -Force` ile kontrol et). Çıkan her bağlantıyı kullanıcıya göster. Bu liste CLI'daki F-vlad-083 düzeltmesinin yerine geçmez; ek güvencedir.

## Uzak makinedeki görev/faz: gate

**Uzak makinedeki görev/faz** (config'te `machines` varken görev bir işçiye yerleşmişse): gate yerelde değil işçide, görevin kendi worktree'sinde çalışır: `vlad task gate <id> [--target integration|task] --json` (varsayılan görev türüne göre: pipeline çatısı → `integration` = çatı worktree'si; dev görevi/fazı → `task` = görevin kendisi; çıkış kodu 1 = kırmızı, 75 = makine erişilemiyor). Komut önce kb'yi işçiye senkronlar; işçi kartın `gate`'ini kendi kb klonundan okur.

## Uzak görev/faz: merge

- **Uzak görev/faz:** merge yerel `git merge` ile değil, onaydan sonra `vlad task merge <id> [--into <dal>] [--message …] --json` ile işçide yapılır (`--no-ff`; **push yok**; çakışmada işçi geri alır, görev `done` yapılmaz). Hedef dalı (varsayılan `vlad/<çatı>` ya da `default_branch`) yine önce göster ve onaylat. Makine kapalıyken (çıkış 75) elle yerel merge deneme; tekrar dene ya da `/status` ile `vlad task release`.

## Çok projeli (faz projesi ≠ çatı projesi)

- **Çok projeli (faz projesi ≠ çatı projesi):** çatı görevin `worktree` alanı faz projesinin entegrasyon worktree'si **değildir** (yalnız çatının kendi projesindekidir). Hedef worktree'yi çatının `integration_worktrees` alanından (`vlad task list --json --full`: varsayılan kısa çıktıda bu alan yoktur; öğe `{project, repo, branch, worktree}`) faz projesinin satırından seç; faz branch'i de faz projesinin reposundadır. Merge orada yapılır. Kapı doğrulaması, diff ve merge her projede ayrı; son kapı onayı ortak tek karardır.
