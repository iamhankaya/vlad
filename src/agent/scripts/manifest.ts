import { NotImplementedOp } from "../ops/index.js";
import type { ScriptManifest, ScriptPlatform } from "../../fleet/types.js";

// Sözleşme (T20261109-05): imzalar. Gövdeler uygulama fazındadır (a: script-list/run + bütünlük + CLI).

/**
 * `git show HEAD:agent-scripts/manifest.json` çıktısını (ayrıştırılmış JSON) doğrular. Şema ihlali ya da çift (name, platform)
 * → `RemoteError("failed", "failed: [bad_manifest] …")`; kısmi kabul yok.
 */
export function validateScriptManifest(_raw: unknown): ScriptManifest {
  throw new NotImplementedOp("script-list");
}

export interface ScriptPlanInput { machine: string; name: string; platform: ScriptPlatform; sha256: string; params: Record<string, string> }
/**
 * Write onayı için plan-id: `hex(sha256("VLAD-PLAN1\n"+machine+"\n"+name+"\n"+platform+"\n"+sha256+"\n"+canonicalJson(params)))[:16]`
 * (`canonicalJson`: agent/sign.ts). CLI (`--plan`) ve Agent (`approval.planId` denetimi) aynı işlevi kullanır.
 */
export function scriptPlanId(_i: ScriptPlanInput): string {
  throw new NotImplementedOp("script-run");
}
