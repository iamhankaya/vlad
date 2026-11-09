#!/bin/bash
# vlad-guncelle (POSIX): Agent'in kendi vlad klonunu gunceller (selfUpdate). Adimlar: kirli degil mi -> fetch + pull --ff-only -> npm ci ->
# tsc --outDir dist-next -> dist'i atomik degistir (dist -> dist-old, dist-next -> dist). Hata halinde ESKI dist aynen kalir.
# dist, derlendigi HEAD'i dist/.build-head'e yazar: HEAD ilerlemis ama derleme onceki kosuda basarisizsa tekrar derlenir.
# Basari: ok:true. Agent bunun uzerine (exit 0 + data.ok true) kendini yeniden baslatir. Yalniz ASCII.
# Not: `npm ci` node_modules'i siler; ortasinda kesilirse (guc kaybi) docs/agent-scripts.md "Kurtarma" adimlari uygulanir.
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

[ -z "$(git status --porcelain --untracked-files=no 2>/dev/null)" ] || fail dirty "izlenen dosyalarda yerel degisiklik var; temizlenmeden guncellenmez"
git symbolic-ref -q HEAD >/dev/null 2>&1 || fail detached "HEAD detached; bir dala gec"
git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1 || fail no_upstream "dalin upstream'i yok"

from=$(git rev-parse --short HEAD)
GIT_TERMINAL_PROMPT=0 git fetch --prune >&2 || fail fetch "git fetch basarisiz"
GIT_TERMINAL_PROMPT=0 git pull --ff-only >&2 || fail pull "git pull --ff-only basarisiz (ayrisik dal ya da catisma)"
to=$(git rev-parse --short HEAD)
full=$(git rev-parse HEAD)

if [ "$from" = "$to" ] && [ -f dist/.build-head ] && [ "$(cat dist/.build-head)" = "$full" ]; then
  printf '@@VLAD-RESULT@@ {"ok":true,"changed":false,"from":"%s","to":"%s","summary":"vlad zaten guncel (%s)"}\n' "$from" "$to" "$to"
  exit 0
fi

npm ci --no-audit --no-fund >&2 || fail install "npm ci basarisiz; node_modules bozulmus olabilir (docs/agent-scripts.md Kurtarma)"

rm -rf dist-next
if ! npx --no-install tsc --outDir dist-next >&2 || [ ! -f dist-next/cli.js ]; then
  rm -rf dist-next
  fail build "tsc derlemesi basarisiz; eski dist korundu"
fi
printf '%s' "$full" > dist-next/.build-head

rm -rf dist-old
if [ -d dist ]; then mv dist dist-old || { rm -rf dist-next; fail swap "dist dist-old'a tasinamadi; eski dist korundu"; }; fi
if ! mv dist-next dist; then
  [ -d dist-old ] && mv dist-old dist
  fail swap "dist-next dist'e tasinamadi; eski dist geri yuklendi"
fi
rm -rf dist-old 2>/dev/null

printf '@@VLAD-RESULT@@ {"ok":true,"changed":true,"from":"%s","to":"%s","summary":"vlad guncellendi: %s -> %s, dist yenilendi"}\n' "$from" "$to" "$from" "$to"
