#!/usr/bin/env bash
# Mac CI runner kurulumu (GitHub self-hosted), F-vlad-116. AYRI, admin olmayan kullanıcı hesabında çalıştırılır.
# Varsayılan --dry-run: ağa çıkmaz, hiçbir şey yazmaz. --apply: indirir, sha256 doğrular, kaydeder, LaunchAgent kurar.
#
#   ci-runner.sh --repo-url https://github.com/<sahip>/<repo> --version 2.329.0 --sha256 <hex> [--dir D] [--name N] [--labels L]
#                [--apply --token-stdin]        # kayıt token'ı stdin'den (argv'ye/ortam değişkenine yazılmaz)
#
# --version ve --sha256 GitHub'ın runner sürüm sayfasından kullanıcı tarafından verilir (sabitlenmiş; "latest" yok).
# Ortam: VLAD_CI_USER (vars. vlad-ci; --apply bu kullanıcıyla çalışmalı), VLAD_UNAME_M (test)
# Bilinen sınır: config.sh token'ı yalnız argv ile alır; 1 saat geçerli, tek kullanımlık kayıt token'ı kısa süre `ps`te görünür.
set -euo pipefail

APPLY=0; TOKEN_STDIN=0; REPO_URL=""; VERSION=""; SHA=""; DIR="$HOME/actions-runner"
NAME="$(hostname -s 2>/dev/null || echo mac)-ci"; LABELS="self-hosted,macOS,vlad-ci"
die() { echo "hata: $*" >&2; exit "${2:-1}"; }
need() { [ $# -ge 2 ] || die "$1 bir değer ister" 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    --token-stdin) TOKEN_STDIN=1 ;;
    --repo-url) need "$@"; REPO_URL="$2"; shift ;;
    --version) need "$@"; VERSION="$2"; shift ;;
    --sha256) need "$@"; SHA="$2"; shift ;;
    --dir) need "$@"; DIR="$2"; shift ;;
    --name) need "$@"; NAME="$2"; shift ;;
    --labels) need "$@"; LABELS="$2"; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    --token) die "token argv ile verilmez; --token-stdin kullan" 2 ;;
    *) die "bilinmeyen bayrak: $1" 2 ;;
  esac
  shift
done

[[ "$REPO_URL" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "--repo-url https://github.com/<sahip>/<repo> biçiminde olmalı" 2
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "--version X.Y.Z olmalı (latest yok)" 2
[[ "$SHA" =~ ^[0-9a-fA-F]{64}$ ]] || die "--sha256 64 hex olmalı" 2
[[ "$NAME" =~ ^[A-Za-z0-9_.-]+$ ]] || die "--name yalnız harf/rakam/._-" 2
[[ "$LABELS" =~ ^[A-Za-z0-9_.,-]+$ ]] || die "--labels yalnız harf/rakam/._-," 2

case "${VLAD_UNAME_M:-$(uname -m)}" in
  arm64) PLAT=osx-arm64 ;; x86_64) PLAT=osx-x64 ;; *) die "desteklenmeyen mimari" ;;
esac
FILE="actions-runner-$PLAT-$VERSION.tar.gz"
URL="https://github.com/actions/runner/releases/download/v$VERSION/$FILE"
TAG="[dry-run]"; [ "$APPLY" = 1 ] && TAG="[apply]"

CI_USER="${VLAD_CI_USER:-vlad-ci}"
if [ "$APPLY" = 1 ]; then
  [ "$(id -u)" != 0 ] || die "root ile çalıştırma; runner root olmamalı"
  [ "$(id -un)" = "$CI_USER" ] || die "yalnız CI hesabıyla ($CI_USER) çalıştırılır; şu an: $(id -un). Beyin kullanıcısında kurma"
  # beyin hesabı işareti: VLAD_CI_USER=$(id -un) ile yukarıdaki denetim atlatılamaz
  for m in "$HOME/.vlad-agent" "$HOME/dev/vlad-kb" "$HOME/.claude"; do
    [ ! -e "$m" ] || die "$m var: bu beyin hesabı gibi görünüyor ($CI_USER); runner yalnız ayrı CI hesabında kurulur"
  done
  if id -Gn | tr ' ' '\n' | grep -qx admin; then die "$CI_USER admin grubunda; runner admin olmayan hesapta çalışmalı"; fi
  [ "$TOKEN_STDIN" = 1 ] || [ -f "$DIR/.runner" ] || die "kayıt için --token-stdin gerekir" 2
fi

if command -v xcode-select >/dev/null 2>&1 && xcode-select -p >/dev/null 2>&1; then
  echo "$TAG xcode-select: $(xcode-select -p) (iOS build için Xcode lisansı/kurulumu ayrıca doğrulanmalı)"
else
  echo "$TAG UYARI: Xcode/Command Line Tools yok; iOS build çalışmaz"
fi

if [ -f "$DIR/.runner" ]; then
  echo "$TAG $DIR zaten kayıtlı; indirme/kayıt atlanır"
else
  echo "$TAG indir: $URL"
  echo "$TAG sha256 doğrula ($SHA), aç: $DIR"
  echo "$TAG ./config.sh --unattended --url $REPO_URL --token <stdin> --name $NAME --labels $LABELS"
  if [ "$APPLY" = 1 ]; then
    TOKEN=""; IFS= read -r TOKEN || true
    [ -n "$TOKEN" ] || die "stdin'de token yok"
    umask 077
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    curl --proto '=https' --proto-redir '=https' -fsSL -o "$tmp/$FILE" "$URL"
    got="$(shasum -a 256 "$tmp/$FILE" | awk '{print $1}')"
    [ "$(printf '%s' "$got" | tr A-F a-f)" = "$(printf '%s' "$SHA" | tr A-F a-f)" ] || die "sha256 uyuşmuyor (beklenen $SHA, gelen $got); kurulum yapılmadı"
    mkdir -p -m 700 "$DIR"; tar xzf "$tmp/$FILE" -C "$DIR"
    ( cd "$DIR" && ./config.sh --unattended --url "$REPO_URL" --token "$TOKEN" --name "$NAME" --labels "$LABELS" >/dev/null )
    TOKEN=""
  fi
fi

if [ -f "$DIR/.service" ]; then
  echo "$TAG servis zaten kurulu"
else
  echo "$TAG ./svc.sh install && ./svc.sh start (kullanıcı LaunchAgent; $CI_USER GUI oturumunda açık olmalı)"
  if [ "$APPLY" = 1 ]; then ( cd "$DIR" && ./svc.sh install && ./svc.sh start ); fi
fi

cat <<'USER'

KULLANICI ADIMI (betik yapmaz; dışa etkili ya da yönetici yetkisi ister; ayrıntı: docs/mac-ci-runner.md):
  1. Ayrı hesap: sudo sysadminctl -addUser vlad-ci -fullName "VLAD CI" -password - (admin olmayan); otomatik giriş/fast-user-switching §2
  2. GitHub > Settings > Actions > Runners > New self-hosted runner: kayıt token'ı üret (1 saat geçerli), --token-stdin ile ver
  3. Repo/org ayarı: Actions > General > "Fork pull request workflows": fork PR'larda çalıştırma KAPALI (en az: onay iste); repo private kalmalı
  4. Workflow'larda runs-on etiketi: [self-hosted, macOS, vlad-ci]; yalnız güvenilen dallar/PR'lar
  5. Ağır işte VLAD paralelliğini düşür: vlad.config.json machines[mac].maxParallel
USER
