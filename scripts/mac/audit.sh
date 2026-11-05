#!/usr/bin/env bash
# Mac mini (beyin) kurulum denetimi, F-vlad-115. YALNIZ OKUR: dosya yazmaz, servis başlatmaz/durdurmaz.
# Kullanım: audit.sh [--json] [--strict]    (--strict: eksik varsa çıkış kodu 1)
# Ortam: VLAD_REPO_DIR (vars. $HOME/dev/vlad), VLAD_KB_DIR (vars. $HOME/dev/vlad-kb), VLAD_CI_USER (vars. vlad-ci), VLAD_CI_HOME (vars. ~$VLAD_CI_USER), VLAD_AGENT_PORT (vars. 7437)
set -euo pipefail

JSON=0; STRICT=0
for a in "$@"; do
  case "$a" in
    --json) JSON=1 ;;
    --strict) STRICT=1 ;;
    -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
    *) echo "bilinmeyen bayrak: $a" >&2; exit 2 ;;
  esac
done

REPO="${VLAD_REPO_DIR:-$HOME/dev/vlad}"
KB="${VLAD_KB_DIR:-$HOME/dev/vlad-kb}"
CI_USER="${VLAD_CI_USER:-vlad-ci}"
PORT="${VLAD_AGENT_PORT:-7437}"
LA="$HOME/Library/LaunchAgents"

ROWS=()
row() { ROWS+=("$1|$2|$3"); }   # madde|durum|kanit  (durum: ok | eksik | uyarı | manuel)
have() { command -v "$1" >/dev/null 2>&1; }
# $(...) içinde `|| true`: bir komutun hatası denetimi durdurmaz, satır "eksik" olur
first() { head -n1 | tr -d '\r'; }

# --- araçlar ---
if have claude; then row claude ok "$(claude --version 2>/dev/null | first || true)"; else row claude eksik "claude PATH'te yok"; fi

if have node; then
  v="$(node -v 2>/dev/null | first || true)"; major="${v#v}"; major="${major%%.*}"
  if [[ "$major" =~ ^[0-9]+$ ]] && [ "$major" -ge 22 ]; then row node ok "$v"; else row node eksik "$v (>=22 gerekir)"; fi
else row node eksik "node PATH'te yok"; fi

for t in git tmux gh; do
  if have "$t"; then row "$t" ok "$(command -v "$t")"; else row "$t" eksik "$t PATH'te yok"; fi
done
if have vlad; then row vlad-cli ok "$(command -v vlad)"; else row vlad-cli eksik "vlad PATH'te yok (npm link / vlad install)"; fi

# --- klonlar ---
if [ -d "$REPO" ] && git -C "$REPO" rev-parse >/dev/null 2>&1; then
  if [ -f "$REPO/dist/cli.js" ]; then row vlad-repo ok "$REPO (dist/cli.js var)"; else row vlad-repo uyarı "$REPO klonu var, dist/cli.js yok (npm run build)"; fi
else row vlad-repo eksik "$REPO git klonu değil/yok"; fi

if [ -d "$KB" ]; then
  url="$(git -C "$KB" remote get-url origin 2>/dev/null | first || true)"
  case "$url" in
    *vlad-kb*) row vlad-kb ok "$KB -> $url" ;;
    *) row vlad-kb uyarı "$KB var ama origin vlad-kb değil/yok (${url:-origin yok})" ;;
  esac
else row vlad-kb eksik "$KB yok"; fi

# --- Agent anahtarları: yalnız ANAHTAR ADLARI okunur, değerler asla basılmaz ---
LOCAL="$REPO/vlad.local.json"
if [ -f "$LOCAL" ]; then
  names="$(grep -oE '"[A-Za-z0-9_.-]+"[[:space:]]*:[[:space:]]*"[0-9a-fA-F]{64}"' "$LOCAL" | sed -E 's/^"([^"]+)".*/\1/' | tr '\n' ',' | sed 's/,$//' || true)"
  if [ -n "$names" ]; then row agent-keys ok "anahtar adları: $names"; else row agent-keys eksik "vlad.local.json'da 64 hex anahtar yok (vlad agent keygen/setkey)"; fi
else row agent-keys eksik "$LOCAL yok (vlad agent keygen)"; fi

# --- launchd / Agent ---
LC="launchctl"
loaded() { $LC list 2>/dev/null | awk -v l="$1" '$3==l{f=1} END{exit !f}'; }
if [ -f "$LA/com.vlad.agent.plist" ]; then
  if loaded com.vlad.agent; then row agent-launchd ok "plist + yüklü (com.vlad.agent)"; else row agent-launchd uyarı "plist var ama launchctl'de yüklü değil"; fi
else row agent-launchd eksik "com.vlad.agent.plist yok (vlad agent install --apply)"; fi

if have lsof && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then row agent-port ok "TCP $PORT dinleniyor"; else row agent-port eksik "TCP $PORT dinlenmiyor (vlad agent start)"; fi

# --- ana oturum (tmux + launchd) ---
sess="yok"; if have tmux && tmux has-session -t vlad >/dev/null 2>&1; then sess="var"; fi
if [ -f "$LA/com.vlad.main.plist" ] && [ "$sess" = var ]; then row main-session ok "tmux 'vlad' oturumu var; com.vlad.main.plist kurulu"
elif [ "$sess" = var ]; then row main-session uyarı "tmux 'vlad' var ama açılışta başlatma yok (scripts/mac/setup.sh)"
else row main-session eksik "tmux 'vlad' oturumu yok (scripts/mac/setup.sh)"; fi

# --- uyku ---
if have pmset; then
  sl="$(pmset -g 2>/dev/null | awk '$1=="sleep"{print $2; exit}' || true)"
  if [ "$sl" = "0" ]; then row sleep ok "pmset sleep 0"; else row sleep eksik "pmset sleep=${sl:-?} (sudo pmset -a sleep 0)"; fi
  ar="$(pmset -g 2>/dev/null | awk '$1=="autorestart"{print $2; exit}' || true)"
  if [ "$ar" = "1" ]; then row autorestart ok "elektrik gidince kendiliğinden açılır"; else row autorestart uyarı "autorestart=${ar:-?} (sudo pmset -a autorestart 1)"; fi
else row sleep uyarı "pmset yok (macOS değil mi?)"; row autorestart uyarı "pmset yok"; fi

# --- elle doğrulanır ---
row remote-control manuel "Claude Code Remote Control açık mı: ana oturumda /remote-control; betikle denetlenemez"

# --- CI (F-vlad-116): ayrı hesap + runner ---
if id "$CI_USER" >/dev/null 2>&1; then
  if id -Gn "$CI_USER" 2>/dev/null | tr ' ' '\n' | grep -qx admin; then row ci-user uyarı "$CI_USER var ama admin grubunda (olmamalı)"; else row ci-user ok "$CI_USER var, admin değil"; fi
else row ci-user eksik "$CI_USER hesabı yok (docs/mac-ci-runner.md §2, kullanıcı adımı)"; fi

CI_HOME="${VLAD_CI_HOME:-$(eval echo "~$CI_USER" 2>/dev/null || true)}"
if [ -n "$CI_HOME" ] && [ -f "$CI_HOME/actions-runner/.runner" ]; then row ci-runner ok "$CI_HOME/actions-runner kayıtlı"; else row ci-runner eksik "runner kayıtlı değil (scripts/mac/ci-runner.sh)"; fi

# --- çıktı ---
jesc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
missing=0
if [ "$JSON" = 1 ]; then
  printf '['; sep=''
  for r in "${ROWS[@]}"; do
    IFS='|' read -r m d k <<<"$r"; [ "$d" = eksik ] && missing=$((missing+1))
    printf '%s{"madde":"%s","durum":"%s","kanit":"%s"}' "$sep" "$(jesc "$m")" "$d" "$(jesc "$k")"; sep=','
  done
  printf ']\n'
else
  printf '%-16s %-7s %s\n' MADDE DURUM KANIT
  for r in "${ROWS[@]}"; do
    IFS='|' read -r m d k <<<"$r"; [ "$d" = eksik ] && missing=$((missing+1))
    printf '%-16s %-7s %s\n' "$m" "$d" "$k"
  done
fi
if [ "$STRICT" = 1 ] && [ "$missing" -gt 0 ]; then exit 1; fi
exit 0
