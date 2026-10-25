#!/bin/bash
# VLAD server install (S14a). Ubuntu 24.04 (arm64 or amd64), run as root from a checkout of the repo:
#   sudo CLAUDE_CODE_VERSION=<exact version> deploy/install.sh
# Idempotent. Nothing secret is written: keys, PAT and the Claude login are placed by hand (RUNBOOK.md).
# VLAD_INSTALL_DRYRUN=1 prints every state-changing command instead of running it (no root needed); used by the S14c rehearsal and CI.
#
# Variables (all optional except CLAUDE_CODE_VERSION):
#   CLAUDE_CODE_VERSION  exact @anthropic-ai/claude-code version to install (no "latest": the install must be repeatable)
#   KB_DIR               kb checkout            (default /var/lib/vlad/kb)
#   VLAD_HOME_DIR        code root, root-owned  (default /opt/vlad)
#   NODE_KEY_FPR / GH_KEY_FPR / TS_KEY_FPR   expected fingerprint of the apt signing key; when set, a mismatch aborts
#   AUDIT_ALLOW=1        continue when `npm audit` reports high/critical findings (a decision, written in the report)
#   HARDEN_SSH=1         install deploy/sshd/50-vlad.conf (key-only login); run `sshd -t` first, keep a second session open
#   ENABLE_UNITS=1       enable the timers/sockets/services after install (otherwise the next steps are printed)
set -euo pipefail

DRY=${VLAD_INSTALL_DRYRUN:-0}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
KB_DIR=${KB_DIR:-/var/lib/vlad/kb}
VLAD_HOME_DIR=${VLAD_HOME_DIR:-/opt/vlad}
LIBEXEC=/usr/local/libexec/vlad
UNIT_DIR=/etc/systemd/system
ETC=/etc/vlad
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=18 # native TypeScript type stripping (server runs "node src/main.ts")

log() { printf '[install] %s\n' "$*"; }
die() { printf '[install] ERROR: %s\n' "$*" >&2; exit 1; }
# state-changing commands go through run() so the dry run shows them
run() { if [[ $DRY == 1 ]]; then printf '+ %s\n' "$*"; else "$@"; fi; }
# a file written from stdin
put() { # put <mode> <owner:group> <path>
  if [[ $DRY == 1 ]]; then printf '+ write %s (%s %s)\n' "$3" "$1" "$2"; cat >/dev/null; return; fi
  local tmp; tmp=$(mktemp "$3.XXXXXX")
  cat >"$tmp"; chmod "$1" "$tmp"; chown "$2" "$tmp"; mv -f "$tmp" "$3"
}

# --- 0. preflight ---------------------------------------------------------------------------------------------------------
if [[ $DRY != 1 ]]; then
  [[ $EUID -eq 0 ]] || die "run as root"
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 24.04 ]] || die "Ubuntu 24.04 expected (found ${PRETTY_NAME:-unknown})"
  pidof systemd >/dev/null || die "systemd is not PID 1"
fi
[[ ${CLAUDE_CODE_VERSION:-} =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "set CLAUDE_CODE_VERSION to an exact version, e.g. 1.2.3"
[[ $KB_DIR == /* && $VLAD_HOME_DIR == /* ]] || die "KB_DIR and VLAD_HOME_DIR must be absolute"
[[ $KB_DIR =~ ^[A-Za-z0-9/._-]+$ && $VLAD_HOME_DIR =~ ^[A-Za-z0-9/._-]+$ ]] || die "KB_DIR / VLAD_HOME_DIR: only [A-Za-z0-9/._-]"
[[ -f $REPO/package-lock.json && -f $REPO/server/package-lock.json ]] || die "lock files missing (package-lock.json, server/package-lock.json)"
ARCH=$(dpkg --print-architecture 2>/dev/null || echo unknown)
log "arch=$ARCH kb=$KB_DIR home=$VLAD_HOME_DIR dry=$DRY"

# --- 1. apt packages and third-party repos (signed-by keyrings, fingerprints printed) --------------------------------------
export DEBIAN_FRONTEND=noninteractive
run apt-get update -y
run apt-get install -y --no-install-recommends ca-certificates curl gnupg git jq socat rsync acl openssh-server unattended-upgrades

add_repo() { # add_repo <name> <key url> <list line> <expected fingerprint or empty>
  local name=$1 url=$2 line=$3 fpr=$4 ring=/usr/share/keyrings/$1.gpg
  if [[ $DRY == 1 ]]; then printf '+ apt repo %s (key %s)\n' "$name" "$url"; return; fi
  local tmp; tmp=$(mktemp)
  curl -fsSL --proto '=https' --tlsv1.2 "$url" -o "$tmp"
  gpg --dearmor <"$tmp" >"$ring.new"
  local got; got=$(gpg --show-keys --with-colons "$ring.new" | awk -F: '$1=="fpr"{print $10; exit}')
  log "$name signing key fingerprint: $got"
  if [[ -n $fpr && $got != "$fpr" ]]; then rm -f "$ring.new" "$tmp"; die "$name key fingerprint mismatch"; fi
  mv -f "$ring.new" "$ring"; chmod 644 "$ring"; rm -f "$tmp"
  printf '%s\n' "${line//@RING@/$ring}" >"/etc/apt/sources.list.d/$name.list"
}
add_repo nodesource https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  "deb [arch=$ARCH signed-by=@RING@] https://deb.nodesource.com/node_22.x nodistro main" "${NODE_KEY_FPR:-}"
add_repo githubcli https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  "deb [arch=$ARCH signed-by=@RING@] https://cli.github.com/packages stable main" "${GH_KEY_FPR:-}"
add_repo tailscale https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg \
  "deb [signed-by=@RING@] https://pkgs.tailscale.com/stable/ubuntu noble main" "${TS_KEY_FPR:-}"
run apt-get update -y
run apt-get install -y --no-install-recommends nodejs gh tailscale

if [[ $DRY != 1 ]]; then
  node_v=$(node --version | sed 's/^v//'); IFS=. read -r nmaj nmin _ <<<"$node_v"
  ((nmaj > NODE_MIN_MAJOR || (nmaj == NODE_MIN_MAJOR && nmin >= NODE_MIN_MINOR))) || die "node $node_v too old (need >= $NODE_MIN_MAJOR.$NODE_MIN_MINOR)"
fi

# --- 2. users and groups: vlad (agent), vladapi (gate), vladchat (chat agent) ------------------------------------------------
# Three uids, three trust levels. The kb is the only shared place (group vlad). vladapi and vladchat are members of group vlad only to read the kb.
ensure_group() { getent group "$1" >/dev/null || run groupadd --system "$1"; }
ensure_user() { # ensure_user <name> <home> <shell> <system 0|1>
  getent passwd "$1" >/dev/null && return 0
  if [[ $4 == 1 ]]; then run useradd --system --gid "$1" --home-dir "$2" --create-home --shell "$3" "$1"
  else run useradd --gid "$1" --home-dir "$2" --create-home --shell "$3" "$1"; fi
}
for g in vlad vladapi vladchat; do ensure_group "$g"; done
ensure_user vlad /home/vlad /bin/bash 0
ensure_user vladapi /var/lib/vladapi /usr/sbin/nologin 1
ensure_user vladchat /var/lib/vladchat /usr/sbin/nologin 1
run usermod -aG vlad vladapi
run usermod -aG vlad vladchat
# the agent user must not be able to become the gate: no sudo, no shared group with vladapi/vladchat beyond `vlad`
run chmod 0700 /var/lib/vladapi /var/lib/vladchat
run chown vladapi:vladapi /var/lib/vladapi
run chown vladchat:vladchat /var/lib/vladchat
run chmod 0750 /home/vlad
# umask 002 for the agent's login shells and its systemd user manager (workers); group-write on the kb is also forced by setgid + default ACL below
put 0644 root:root /etc/profile.d/vlad-umask.sh <<'EOS'
# VLAD: the agent user writes the shared kb with group write
[ "$(id -un)" = vlad ] && umask 002
EOS
# no process of the agent user starts at boot/logout without linger: workers (systemd-run --user) must survive the SSH session
run loginctl enable-linger vlad

# --- 3. directories ------------------------------------------------------------------------------------------------------------
kb_parent=$(dirname "$KB_DIR")
run install -d -m 0755 -o root -g root "$kb_parent"
run install -d -m 2770 -o vlad -g vlad "$KB_DIR"
run setfacl -m g:vlad:rwx -m d:g:vlad:rwx -m d:u:vlad:rwx "$KB_DIR"
run install -d -m 0750 -o root -g vlad "$ETC"
run install -d -m 0755 -o root -g root "$LIBEXEC"

# --- 4. code: root-owned, read-only for every VLAD user (F-vlad-037) ---------------------------------------------------------
# VLAD_HOME holds dist/, schemas/, roles/, the server and the config. Nobody who runs an agent may write there.
# The only writable subtree is $VLAD_HOME/state (kb conflict backups), owned by vlad.
run install -d -m 0755 -o root -g root "$VLAD_HOME_DIR"
run rsync -a --delete --chmod=Dgo-w,Fgo-w --chown=root:root \
  --exclude=/.git --exclude=node_modules --exclude=/dist --exclude=/state --exclude=/kb --exclude=/server/node_modules \
  --exclude=/vlad.config.json --exclude=/test --exclude=/server/test --exclude=/docs \
  "$REPO/" "$VLAD_HOME_DIR/"
if [[ $DRY == 1 ]]; then
  echo "+ (cd $VLAD_HOME_DIR && npm ci && npm run build && npm prune --omit=dev)"
  echo "+ (cd $VLAD_HOME_DIR/server && npm ci --omit=dev)"
  echo "+ npm audit --omit=dev --audit-level=high (root and server)"
else
  # as root, from a root-owned tree: no dependency script runs as a VLAD user
  (cd "$VLAD_HOME_DIR" && npm ci --no-fund --no-audit && npm run build && npm prune --omit=dev --no-audit)
  (cd "$VLAD_HOME_DIR/server" && npm ci --omit=dev --no-fund --no-audit)
  audit_rc=0
  for d in "$VLAD_HOME_DIR" "$VLAD_HOME_DIR/server"; do
    (cd "$d" && npm audit --omit=dev --audit-level=high) || audit_rc=1
  done
  if ((audit_rc)); then
    [[ ${AUDIT_ALLOW:-0} == 1 ]] || die "npm audit: high/critical findings (decide, then re-run with AUDIT_ALLOW=1)"
    log "WARNING: npm audit findings accepted by AUDIT_ALLOW=1; record the decision"
  fi
fi
run chown -R root:root "$VLAD_HOME_DIR"
run chmod -R go-w "$VLAD_HOME_DIR"
run install -d -m 0700 -o vlad -g vlad "$VLAD_HOME_DIR/state"
if [[ ! -e $VLAD_HOME_DIR/vlad.config.json ]]; then
  # machine specifics (roots, worktreeDir, machines.<name>.kbPushBranch) are filled in by hand: RUNBOOK §A.6
  put 0644 root:root "$VLAD_HOME_DIR/vlad.config.json" <<EOS
{
  "roots": ["/home/vlad/projects"],
  "ignore": ["*-wt", "node_modules"],
  "defaultAutonomy": "commit",
  "staleAfterHours": 6,
  "launcher": "auto",
  "worktreeDir": "{repo}-wt",
  "kbDir": "$KB_DIR",
  "projects": {}
}
EOS
fi

# wrappers: fixed node, no PATH lookup of the CLI entry
put 0755 root:root /usr/local/bin/vlad <<EOS
#!/bin/sh
exec /usr/bin/node "$VLAD_HOME_DIR/dist/cli.js" "\$@"
EOS
put 0755 root:root /usr/local/bin/vlad-server <<EOS
#!/bin/sh
exec /usr/bin/node "$VLAD_HOME_DIR/server/src/cli.ts" "\$@"
EOS

# --- 5. claude (pinned, root-owned prefix) --------------------------------------------------------------------------------------
run install -d -m 0755 -o root -g root /opt/claude-code
if [[ $DRY == 1 ]]; then
  echo "+ npm install -g --prefix /opt/claude-code @anthropic-ai/claude-code@$CLAUDE_CODE_VERSION"
else
  npm install -g --prefix /opt/claude-code --no-fund --no-audit "@anthropic-ai/claude-code@$CLAUDE_CODE_VERSION"
fi
run ln -sfn /opt/claude-code/bin/claude /usr/local/bin/claude

# --- 6. chat sandbox files (F-vlad-024) ---------------------------------------------------------------------------------------
run install -m 0755 -o root -g root "$HERE/bin/vlad-chat-turn" "$LIBEXEC/chat-turn"
run install -m 0755 -o root -g root "$HERE/bin/vlad-chat-client" "$LIBEXEC/chat-client"
# the chat permissions come from the same function the API uses (chatPermissions), rendered once, root-owned
if [[ $DRY == 1 ]]; then
  echo "+ node $VLAD_HOME_DIR/server/scripts/gen-chat-settings.ts $KB_DIR /var/lib/vladapi $VLAD_HOME_DIR > $ETC/chat-settings.json (root:root 0644)"
else
  tmp=$(mktemp)
  node "$VLAD_HOME_DIR/server/scripts/gen-chat-settings.ts" "$KB_DIR" /var/lib/vladapi "$VLAD_HOME_DIR" "$ETC" >"$tmp"
  install -m 0644 -o root -g root "$tmp" "$ETC/chat-settings.json"; rm -f "$tmp"
fi

# --- 7. environment file (no secrets) ---------------------------------------------------------------------------------------------
if [[ ! -e $ETC/vlad.env ]]; then
  if [[ $DRY == 1 ]]; then echo "+ $ETC/vlad.env from deploy/env.example (VLAD_HOME, VLAD_KB_DIR filled)"
  else
    sed -e "s#^VLAD_HOME=.*#VLAD_HOME=$VLAD_HOME_DIR#" -e "s#^VLAD_KB_DIR=.*#VLAD_KB_DIR=$KB_DIR#" \
      -e "s#^VLAD_CHAT_CLIENT=.*#VLAD_CHAT_CLIENT=$LIBEXEC/chat-client#" "$HERE/env.example" >"$ETC/vlad.env"
    chown root:vlad "$ETC/vlad.env"; chmod 0640 "$ETC/vlad.env"
  fi
else
  log "$ETC/vlad.env exists, left as is"
fi

# --- 8. systemd units --------------------------------------------------------------------------------------------------------------
for u in "$HERE"/systemd/*; do
  name=$(basename "$u")
  if [[ $DRY == 1 ]]; then printf '+ unit %s (@KB_DIR@=%s @VLAD_HOME@=%s)\n' "$name" "$KB_DIR" "$VLAD_HOME_DIR"; continue; fi
  sed -e "s#@KB_DIR@#$KB_DIR#g" -e "s#@VLAD_HOME@#$VLAD_HOME_DIR#g" "$u" >"$UNIT_DIR/$name"
  chmod 0644 "$UNIT_DIR/$name"
  ! grep -q '@[A-Z_]*@' "$UNIT_DIR/$name" || die "unfilled template in $name"
done
run systemctl daemon-reload
if [[ ${ENABLE_UNITS:-0} == 1 ]]; then
  run systemctl enable --now vlad-kbsync.timer vlad-kbsync.path vlad-kbpromote.timer vlad-chat.socket vlad-api.service
fi

# --- 9. optional: ssh hardening, automatic security updates ------------------------------------------------------------------------
if [[ ${HARDEN_SSH:-0} == 1 ]]; then
  if [[ $DRY == 1 ]]; then echo "+ install sshd drop-in, sshd -t, systemctl reload ssh"
  else
    install -m 0644 -o root -g root "$HERE/sshd/50-vlad.conf" /etc/ssh/sshd_config.d/50-vlad.conf
    sshd -t || { rm -f /etc/ssh/sshd_config.d/50-vlad.conf; die "sshd -t failed, drop-in removed"; }
    systemctl reload ssh
  fi
fi

cat <<EONEXT
[install] done. Next (RUNBOOK.md §A.5-A.12): tailscale up, kb clone as vlad, claude login (vlad AND vladchat), gh login (PAT), GitHub App key,
          fill $ETC/vlad.env, machines.<name> in $VLAD_HOME_DIR/vlad.config.json, then re-run with ENABLE_UNITS=1 (or enable by hand).
EONEXT
