#!/bin/bash
# vlad-guncelle (POSIX): Agent'in kendi vlad klonunu gunceller (selfUpdate). Adimlar: kirli degil mi -> fetch + pull --ff-only -> npm ci ->
# tsc --outDir dist-next -> dist'i atomik degistir (dist -> dist-old, dist-next -> dist). Hata halinde ESKI dist aynen kalir.
# dist, derlendigi HEAD'i dist/.build-head'e yazar: HEAD ilerlemis ama derleme onceki kosuda basarisizsa tekrar derlenir.
# Basari: ok:true. Agent bunun uzerine (exit 0 + data.ok true) kendini yeniden baslatir. Yalniz ASCII.
# Geri alma: npm ci oncesi node_modules -> node_modules-old (isaret: .vlad-npm-ci-running); npm ci basarisizsa ya da kosu yarida kesildiyse
# (bir sonraki kosunun basinda) eski node_modules geri gelir. dist-old ve node_modules-old BASARIDA SILINMEZ: yeni surec dinlemeye baslayinca
# Agent (Mac: ayrik bekci, Windows: yardimci betik) siler; baslamazsa ayni bekci dist + node_modules'i yedekten geri yukler.
set -u
export LC_ALL=C

jesc() { local s=$1; s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/\\n}; s=${s//$'\r'/\\r}; s=${s//$'\t'/\\t}; printf '%s' "$s"; }
fail() { # adim ozet
  printf '@@VLAD-RESULT@@ {"ok":false,"step":"%s","summary":"%s"}\n' "$1" "$(jesc "$2")"
  exit 1
}

repo="${VLAD_REPO:-}"
[ -n "$repo" ] && [ -e "$repo/.git" ] || fail setup "VLAD_REPO yok ya da git deposu degil"
cd "$repo" || fail setup "VLAD_REPO'ya girilemedi"

# yarida kalan npm ci kurtarma (her seyden once): eski node_modules geri
if [ -e .vlad-npm-ci-running ]; then
  if [ -d node_modules-old ]; then rm -rf node_modules && mv node_modules-old node_modules || fail setup "yarim node_modules yedekten geri yuklenemedi"; fi
  if [ "$(cat .vlad-npm-ci-running 2>/dev/null)" = swap ] && [ -d dist-old ]; then rm -rf dist && mv dist-old dist || fail setup "yarim dist yedekten geri yuklenemedi"; fi
  rm -f .vlad-npm-ci-running
fi

[ -z "$(git status --porcelain --untracked-files=no 2>/dev/null)" ] || fail dirty "izlenen dosyalarda yerel degisiklik var; temizlenmeden guncellenmez"
git symbolic-ref -q HEAD >/dev/null 2>&1 || fail detached "HEAD detached; bir dala gec"
up=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null) || fail no_upstream "dalin upstream'i yok"
# yalniz varsayilan dal (origin/HEAD; yoksa main|master) ve upstream'i origin/<ayni dal> olan klon guncellenir (baska dal/uzak deposu uzaktan kod calistirtmasin)
cur=$(git symbolic-ref -q --short HEAD)
def=$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null); def=${def#origin/}
if [ -n "$def" ]; then [ "$cur" = "$def" ] || fail branch "dal '$cur' varsayilan dal ('$def') degil"; else
  case "$cur" in main|master) ;; *) fail branch "dal '$cur' varsayilan dal degil (main/master)";; esac
fi
[ "$up" = "origin/$cur" ] || fail branch "upstream '$up', beklenen 'origin/$cur'"

from=$(git rev-parse --short HEAD)
GIT_TERMINAL_PROMPT=0 git fetch --prune >&2 || fail fetch "git fetch basarisiz"
GIT_TERMINAL_PROMPT=0 git pull --ff-only >&2 || fail pull "git pull --ff-only basarisiz (ayrisik dal ya da catisma)"
to=$(git rev-parse --short HEAD)
full=$(git rev-parse HEAD)

if [ "$from" = "$to" ] && [ -f dist/.build-head ] && [ "$(cat dist/.build-head)" = "$full" ]; then
  printf '@@VLAD-RESULT@@ {"ok":true,"changed":false,"from":"%s","to":"%s","summary":"vlad zaten guncel (%s)"}\n' "$from" "$to" "$to"
  exit 0
fi

# onceki guncellemenin yedegi duruyorsa (yeni surec henuz dogrulanmadi / temizlenmedi) ustune yazilmaz
[ ! -e node_modules-old ] || fail install "node_modules-old zaten var (onceki guncellemenin yedegi); yeni surec dogrulanip temizlenene ya da elle silinene kadar guncellenmez"
if [ -d node_modules ]; then mv node_modules node_modules-old || fail install "node_modules yedeklenemedi; hicbir sey degismedi"; fi
: > .vlad-npm-ci-running
# npm ci SONRASI her hata yolunda eski node_modules geri gelir (eski dist + yeni node_modules ile surmesin)
restore_nm() { rm -rf node_modules; [ -d node_modules-old ] && mv node_modules-old node_modules; rm -f .vlad-npm-ci-running; }
if ! npm ci --ignore-scripts --no-audit --no-fund >&2; then
  restore_nm
  fail install "npm ci basarisiz; eski node_modules geri yuklendi"
fi

rm -rf dist-next
if ! npx --no-install tsc --outDir dist-next >&2 || [ ! -f dist-next/cli.js ]; then
  rm -rf dist-next
  restore_nm
  fail build "tsc derlemesi basarisiz; eski dist ve eski node_modules korundu"
fi
printf '%s' "$full" > dist-next/.build-head

rm -rf dist-old
printf swap > .vlad-npm-ci-running # asama isareti: bundan sonra kesilirse kurtarma dist'i de dist-old'dan geri yukler
if [ -d dist ]; then mv dist dist-old || { rm -rf dist-next; restore_nm; fail swap "dist dist-old'a tasinamadi; eski dist ve node_modules korundu"; }; fi
if ! mv dist-next dist; then
  [ -d dist-old ] && mv dist-old dist
  restore_nm
  fail swap "dist-next dist'e tasinamadi; eski dist geri yuklendi"
fi

rm -f .vlad-npm-ci-running
printf '@@VLAD-RESULT@@ {"ok":true,"changed":true,"from":"%s","to":"%s","summary":"vlad guncellendi: %s -> %s, dist yenilendi"}\n' "$from" "$to" "$from" "$to"
