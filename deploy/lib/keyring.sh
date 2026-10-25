#!/bin/bash
# Helpers for apt signing keys (sourced by install.sh; unit-tested without network in test/deploy/s14a.test.ts).

# key_to_keyring <downloaded key> <keyring out>: ASCII-armored keys are dearmored, binary keys (gh, tailscale ship these) are copied as they are.
key_to_keyring() {
  local in=$1 out=$2
  if head -c 4096 "$in" | grep -q -e '-----BEGIN PGP PUBLIC KEY BLOCK-----'; then
    gpg --dearmor <"$in" >"$out"
  else
    cp -- "$in" "$out"
  fi
}

# keyring_problem <keyring> <expected primary fingerprint>: prints why the keyring is not acceptable (exactly one primary key, with that fingerprint), nothing if fine.
keyring_problem() {
  local ring=$1 want=$2 n got
  n=$(gpg --show-keys --with-colons "$ring" 2>/dev/null | awk -F: '$1=="pub"{c++} END{print c+0}')
  got=$(gpg --show-keys --with-colons "$ring" 2>/dev/null | awk -F: '$1=="fpr"{print $10; exit}')
  if [[ $n != 1 ]]; then echo "keyring holds $n primary keys (want exactly 1)"; return 0; fi
  if [[ $got != "$want" ]]; then echo "fingerprint $got does not match $want"; return 0; fi
}
