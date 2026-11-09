// Kabul (T20261109-06): kayıtlı bakım betikleri kabul testlerinin ortak betik kümesi (bash). Hepsi sahte; yalnız geçici repoda çalışır.
import type { ScriptParamSpec } from "../../src/fleet/types.js";
import { sh, type FxScript } from "./script-repo.js";

export const typedParams: ScriptParamSpec[] = [
  { name: "tag", type: "string", required: true, maxLen: 8 },
  { name: "mode", type: "enum", values: ["a", "b"] },
  { name: "n", type: "int", min: 1, max: 5 },
  { name: "flag", type: "bool" },
  { name: "word", type: "string", pattern: "^[a-z]{2,4}$" },
];

export const envJson = (extra = "") =>
  `printf '@@VLAD-RESULT@@ {"ok":true,"summary":"s","msg":"%s","mode":"%s","count":"%s","dry":"%s","root":"%s","op":"%s","script":"%s","machine":"%s","repo":"%s","pwd":"%s","self":"%s","gh":"%s","anth":"%s","localfile":"%s","agenttest":"%s"${extra}}\\n' ` +
  `"\${VLAD_PARAM_MSG-}" "\${VLAD_PARAM_MODE-}" "\${VLAD_PARAM_COUNT-}" "\${VLAD_PARAM_DRY_RUN-}" "\${VLAD_PARAM_ROOT-}" "$VLAD_OP_ID" "$VLAD_SCRIPT" "$VLAD_MACHINE" "$VLAD_REPO" "$PWD" "$0" ` +
  `"\${GH_TOKEN-UNSET}" "\${ANTHROPIC_API_KEY-UNSET}" "\${VLAD_LOCAL_FILE-UNSET}" "\${VLAD_AGENT_TEST-UNSET}"`;

export const SCRIPTS: FxScript[] = [
  {
    name: "show-env", body: envJson(),
    params: [
      { name: "msg", type: "string", maxLen: 8, default: "dflt" }, { name: "mode", type: "enum", values: ["fast", "slow"], default: "fast" },
      { name: "count", type: "int", min: 1, max: 5, default: 2 }, { name: "dry-run", type: "bool", default: false }, { name: "root", type: "root" },
    ],
  },
  { name: "mark-read", body: `${sh.mark("mark-read")}\n${sh.result('{"ok":true,"summary":"m"}')}` },
  { name: "mark-write", class: "write", body: `${sh.mark("mark-write")}\n${sh.result('{"ok":true,"summary":"w"}')}` },
  { name: "other-write", class: "write", body: `${sh.mark("other-write")}\n${sh.result('{"ok":true,"summary":"o"}')}` },
  { name: "typed", params: typedParams, body: `${sh.mark("typed")}\n${sh.result('{"ok":true,"summary":"t"}')}` },
  { name: "rooted", params: [{ name: "root", type: "root" }], body: `${sh.mark("rooted")}\n${envJson()}` },
  { name: "fail3", body: `echo oops-out\necho oops-err >&2\n${sh.mark("fail3")}\nexit 3` },
  { name: "no-sentinel", body: "echo plain output" },
  { name: "bad-json", body: "echo '@@VLAD-RESULT@@ {nope'" },
  { name: "array-json", body: "echo '@@VLAD-RESULT@@ [1,2]'" },
  { name: "big-json", body: `printf '@@VLAD-RESULT@@ {"ok":true,"blob":"%s"}\\n' "$(head -c 20000 /dev/zero | tr '\\0' 'x')"` },
  { name: "old-sentinel", body: `echo '@@VLAD-RESULT@@ {"ok":true,"summary":"old"}'\ni=0; while [ $i -lt 25 ]; do echo "later-$i"; i=$((i+1)); done` },
  { name: "two-sentinels", body: `echo '@@VLAD-RESULT@@ {"ok":true,"summary":"first"}'\necho 'warning: noise'\necho '@@VLAD-RESULT@@ {"ok":true,"summary":"second"}'\necho 'trailing log line'` },
  { name: "restart-key", body: `echo '@@VLAD-RESULT@@ {"ok":true,"summary":"r","restart":"scheduled"}'` },
  { name: "sleeper", timeoutSec: 1, body: `${sh.mark("sleeper")}\nsleep 60 &\necho $! > "$VLAD_REPO/.childpid"\nwait` },
  { name: "loud-small", outputMaxKb: 1, body: `i=0; while [ $i -lt 3000 ]; do echo "line-$i-xxxxxxxxxx"; i=$((i+1)); done\n${sh.result('{"ok":true}')}` },
  { name: "loud-default", body: `i=0; while [ $i -lt 12000 ]; do echo "line-$i-xxxxxxxxxx"; i=$((i+1)); done\nhead -c 100000 /dev/zero | tr '\\0' 'e' >&2\n${sh.result('{"ok":true}')}` },
  { name: "hold", class: "write", timeoutSec: 120, body: `touch "$VLAD_REPO/.started-hold"\nn=0; while [ ! -f "$VLAD_REPO/.release" ] && [ $n -lt 600 ]; do sleep 0.1; n=$((n+1)); done\n${sh.mark("hold")}\n${sh.result('{"ok":true,"summary":"h"}')}` },
  { name: "win-only", platform: "win32", body: "Write-Output 'x'" },
  // (b) kendini güncelleme
  { name: "self-ok", class: "write", selfUpdate: true, body: sh.result('{"ok":true,"summary":"u"}') },
  { name: "self-notok", class: "write", selfUpdate: true, body: sh.result('{"ok":false,"summary":"u"}') },
  { name: "self-fail", class: "write", selfUpdate: true, body: `${sh.result('{"ok":true,"summary":"u"}')}\nexit 2` },
  { name: "self-hold", class: "write", selfUpdate: true, timeoutSec: 120, body: `touch "$VLAD_REPO/.started-self-hold"\nn=0; while [ ! -f "$VLAD_REPO/.release" ] && [ $n -lt 600 ]; do sleep 0.1; n=$((n+1)); done\n${sh.result('{"ok":false,"summary":"h"}')}` },
];

