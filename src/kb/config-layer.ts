import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Kişisel katman (gitignored): tracked `vlad.config.json` üstüne sığ birleşir, `null` anahtarı siler (T20261110-05). */
export const LOCAL_CONFIG_FILE = "vlad.config.local.json";

function readObject(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  let v: unknown;
  try { v = JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new Error(`config okunamadı (${file}): ${(e as Error).message}`); }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`config okunamadı (${file}): nesne olmalı`);
  return v as Record<string, unknown>;
}

/** Ham birleşim (varsayılanlar ve doğrulama YOK): config, kbDir ve forward okuyucularının tek kaynağı. */
export function readConfigLayers(home: string): Record<string, unknown> {
  const merged = { ...readObject(join(home, "vlad.config.json")) };
  for (const [k, v] of Object.entries(readObject(join(home, LOCAL_CONFIG_FILE)))) {
    if (v === null) delete merged[k];
    else merged[k] = v;
  }
  return merged;
}
