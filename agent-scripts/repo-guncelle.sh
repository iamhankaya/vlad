#!/bin/bash
# repo-guncelle (POSIX): kok klasorlerdeki git depolarini `fetch --prune` + `pull --ff-only` ile gunceller.
# Parametre: VLAD_PARAM_ROOT (tek kok) ya da VLAD_ROOTS (';' ile ayrilmis). Agent'in kendi klonu (VLAD_REPO) atlanir:
# onu vlad-guncelle gunceller. Kirli, detached, upstream'siz ve ayrismis depolar atlanir (hata sayilmaz).
# Sonuc: stdout'un son satirlarinda `@@VLAD-RESULT@@ {json}`. Yalniz ASCII (PS ile ayni sozlesme).
set -u
export LC_ALL=C

jesc() { # JSON dizge kacisi (ters bolu, tirnak, kontrol karakterleri)
  local s=$1
  s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/\\n}; s=${s//$'\r'/\\r}; s=${s//$'\t'/\\t}
  printf '%s' "$s"
}

roots=()
if [ -n "${VLAD_PARAM_ROOT:-}" ]; then roots=("$VLAD_PARAM_ROOT")
else IFS=';' read -r -a roots <<< "${VLAD_ROOTS:-}"; fi

agent_repo=""
[ -n "${VLAD_REPO:-}" ] && agent_repo=$(cd "$VLAD_REPO" 2>/dev/null && pwd -P)

items=(); n_upd=0; n_cur=0; n_skip=0; n_err=0; n_all=0; extra=0; MAX_ITEMS=80
add() { # ad durum alanlar...
  n_all=$((n_all + 1))
  if [ ${#items[@]} -ge $MAX_ITEMS ]; then extra=$((extra + 1)); return; fi
  items+=("{\"name\":\"$(jesc "$1")\",\"status\":\"$2\"$3}")
}
skip() { n_skip=$((n_skip + 1)); add "$1" skipped ",\"reason\":\"$2\""; }
err()  { n_err=$((n_err + 1)); add "$1" error ",\"reason\":\"$2\""; }

# bash 3.2 (macOS): bos dizide set -u hata verir, bu yuzden ${dizi[@]+...} kalibi
for root in ${roots[@]+"${roots[@]}"}; do
  [ -d "$root" ] || { echo "root yok: $root" >&2; continue; }
  for dir in "$root"/*/; do
    dir=${dir%/}
    [ -L "$dir" ] && continue   # symlink alt dizin: kok disina cikis, atla
    [ -e "$dir/.git" ] || continue
    name=$(basename "$dir")
    real=$(cd "$dir" && pwd -P)
    if [ -n "$agent_repo" ] && [ "$real" = "$agent_repo" ]; then skip "$name" agent_repo; continue; fi
    branch=$(git -C "$dir" symbolic-ref --short -q HEAD) || { skip "$name" detached; continue; }
    git -C "$dir" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1 || { skip "$name" no_upstream; continue; }
    [ -z "$(git -C "$dir" status --porcelain 2>/dev/null)" ] || { skip "$name" dirty; continue; }
    GIT_TERMINAL_PROMPT=0 git -C "$dir" fetch --prune >/dev/null 2>&1 || { err "$name" fetch_failed; continue; }
    from=$(git -C "$dir" rev-parse --short HEAD)
    if GIT_TERMINAL_PROMPT=0 git -C "$dir" pull --ff-only >/dev/null 2>&1; then
      to=$(git -C "$dir" rev-parse --short HEAD)
      if [ "$from" = "$to" ]; then n_cur=$((n_cur + 1)); add "$name" current ""
      else n_upd=$((n_upd + 1)); add "$name" updated ",\"branch\":\"$(jesc "$branch")\",\"from\":\"$from\",\"to\":\"$to\""; fi
    elif ! git -C "$dir" merge-base --is-ancestor HEAD '@{u}' 2>/dev/null && ! git -C "$dir" merge-base --is-ancestor '@{u}' HEAD 2>/dev/null; then
      skip "$name" diverged
    else err "$name" pull_failed; fi
  done
done

joined=""; for i in ${items[@]+"${items[@]}"}; do joined="${joined:+$joined,}$i"; done
more=""; [ "$extra" -gt 0 ] && more=",\"omitted\":$extra"
printf '@@VLAD-RESULT@@ {"ok":true,"summary":"%s repo: %s guncellendi, %s guncel, %s atlandi, %s hata","repos":[%s]%s}\n' "$n_all" "$n_upd" "$n_cur" "$n_skip" "$n_err" "$joined" "$more"
