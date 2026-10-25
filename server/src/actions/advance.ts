import type { VladOps } from "./ops.ts";

export type AdvanceResult = { started: string[]; failed: string[] };

/**
 * After a phase merged: start the phases of the same pipeline that became ready. Mechanical (`task ready` + `task launch`),
 * no model turn. The merge already happened, so nothing here may fail the action: errors are reported in the result.
 */
export async function advance(ops: VladOps, parent: string | null | undefined, log?: (msg: string) => void): Promise<AdvanceResult> {
  const res: AdvanceResult = { started: [], failed: [] };
  if (!parent) return res;
  let ids: string[];
  try {
    ids = await ops.ready(parent);
  } catch (e) {
    log?.(`advance: ready okunamadı: ${(e as Error).message}`);
    return { started: [], failed: [parent] };
  }
  for (const id of ids) {
    try {
      await ops.launch(id);
      res.started.push(id);
    } catch (e) {
      log?.(`advance: ${id} başlatılamadı: ${(e as Error).message}`);
      res.failed.push(id);
    }
  }
  return res;
}
