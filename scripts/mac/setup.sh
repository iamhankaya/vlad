#!/usr/bin/env bash
# Mac mini (beyin) eksiklerini tamamlar, F-vlad-115. Varsayılan --dry-run: yalnız planı basar.
# Kullanım: setup.sh [--dry-run] [--apply]
#   - ana VLAD oturumu için tmux sarmalayıcı + LaunchAgent (com.vlad.main); idempotent
#   - Agent LaunchAgent yoksa `vlad agent install --apply` (mevcut kod yolu)
#   - sudo gerektirenler (uyku, otomatik açılış) KULLANICI ADIMI olarak basılır, betik sudo çalıştırmaz
# Ortam: VLAD_REPO_DIR (vars. $HOME/dev/vlad), VLAD_MAIN_CMD (vars. claude), VLAD_UNAME (test)
set -euo pipefail

APPLY=0
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "bilinmeyen bayrak: $a" >&2; exit 2 ;;
  esac
done

if [ "${VLAD_UNAME:-$(uname)}" != Darwin ]; then echo "hata: bu betik yalnız macOS içindir" >&2; exit 1; fi

REPO="${VLAD_REPO_DIR:-$HOME/dev/vlad}"
MAIN_CMD="${VLAD_MAIN_CMD:-claude}"
case "$MAIN_CMD" in *$'\n'*|*$'\r'*) echo "hata: VLAD_MAIN_CMD satır sonu içeremez" >&2; exit 1 ;; esac

umask 077   # F-vlad-251: yeni dosya/dizinler yalnız sahibine açık (yürütülebilir olanlar aşağıda açıkça chmod'lanır)
LA="$HOME/Library/LaunchAgents"
AGENT_DIR="$HOME/.vlad-agent"
WRAP="$AGENT_DIR/main-session.sh"
PLIST="$LA/com.vlad.main.plist"
TAG="[dry-run]"; [ "$APPLY" = 1 ] && TAG="[apply]"

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

WRAP_CONTENT="#!/bin/bash
# VLAD ana oturumu: yoksa tmux 'vlad' oturumunu arka planda açar (com.vlad.main LaunchAgent çağırır).
export VLAD_HOME=$(printf '%q' "$REPO")
export PATH=\"/opt/homebrew/bin:/usr/local/bin:\$HOME/.local/bin:/usr/bin:/bin\"
tmux has-session -t vlad 2>/dev/null || tmux new-session -d -s vlad -c \"\$VLAD_HOME\" $MAIN_CMD
"

PLIST_CONTENT="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\"><dict>
<key>Label</key><string>com.vlad.main</string>
<key>ProgramArguments</key><array><string>/bin/bash</string><string>$(xml "$WRAP")</string></array>
<key>RunAtLoad</key><true/>
<key>AbandonProcessGroup</key><true/>
<key>StandardOutPath</key><string>$(xml "$AGENT_DIR/main-session.log")</string>
<key>StandardErrorPath</key><string>$(xml "$AGENT_DIR/main-session.log")</string>
</dict></plist>
"

# içerik aynıysa dokunma (idempotent); değişecekse yaz
write_if_changed() { # yol içerik mod
  if [ -f "$1" ] && cmp -s "$1" <(printf '%s\n' "$2"); then echo "$TAG $1 zaten güncel"; return 0; fi
  echo "$TAG yaz: $1"
  if [ "$APPLY" = 1 ]; then mkdir -p "$(dirname "$1")"; printf '%s\n' "$2" > "$1"; chmod "$3" "$1"; fi
}

if [ "$APPLY" = 1 ]; then mkdir -p -m 700 "$AGENT_DIR"; chmod 700 "$AGENT_DIR"; fi
write_if_changed "$WRAP" "$WRAP_CONTENT" 755
write_if_changed "$PLIST" "$PLIST_CONTENT" 644

if launchctl list 2>/dev/null | awk '$3=="com.vlad.main"{f=1} END{exit !f}'; then
  echo "$TAG com.vlad.main zaten yüklü"
else
  echo "$TAG launchctl bootstrap gui/$(id -u) $PLIST"
  if [ "$APPLY" = 1 ]; then launchctl bootstrap "gui/$(id -u)" "$PLIST"; fi
fi

if [ -f "$LA/com.vlad.agent.plist" ]; then
  echo "$TAG Agent LaunchAgent zaten kurulu"
else
  echo "$TAG vlad agent install --apply (com.vlad.agent)"
  if [ "$APPLY" = 1 ]; then vlad agent install --apply; fi
fi

cat <<'USER'

KULLANICI ADIMI (betik çalıştırmaz; sudo ve etkileşim gerekir):
  1. Uyku kapalı:            sudo pmset -a sleep 0 disksleep 0 womp 1 autorestart 1
  2. Remote Control:         ana oturumda (tmux attach -t vlad) Claude Code içinde /remote-control aç
  3. Agent anahtarları:      docs/machines-setup.md §2 (vlad agent keygen/setkey; anahtar güvenli kanaldan)
  4. Doğrula:                scripts/mac/audit.sh --strict
USER
