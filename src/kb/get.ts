import { join, relative } from "node:path";
import { ARCHIVE, findMdFile } from "./archive.js";
import { readDoc } from "./doc.js";
import { kbPaths } from "./home.js";
import { getSection } from "./sections.js";

export interface KbRecord {
  id: string;
  kind: "task" | "finding";
  /** absolute path of the file (archive included) */
  file: string;
  /** path inside the kb with `/` separators (what a cloud worker finds in its clone) */
  relative: string;
  archived: boolean;
  data: Record<string, unknown>;
  /** the requested section's text, else the whole body */
  content: string;
}

/** Path of a task/finding inside the kb (`tasks/<id>.md` or `tasks/archive/<YYYY-MM>/<id>.md`); null when it does not exist. */
export function kbRelativePath(id: string): string | null {
  const dir = /^T\d{8}-\d{2,}$/.test(id) ? kbPaths().tasks : /^F-[a-z0-9-]+-\d+$/.test(id) ? kbPaths().findings : null;
  const file = dir && findMdFile(dir, id);
  return file ? relative(kbPaths().kb, file).split("\\").join("/") : null;
}

/** Reads a task or finding by id wherever it lives (live or archive); `section` narrows `content` to one `## ` section. */
export function getKbRecord(id: string, section?: string): KbRecord {
  if (!/^(T\d{8}-\d{2,}|F-[a-z0-9-]+-\d+)$/.test(id)) throw new Error(`geçersiz ID: ${id} (görev T<YYYYMMDD>-<NN> ya da bulgu F-<proje>-<NNN>)`);
  const rel = kbRelativePath(id);
  if (!rel) throw new Error(`kayıt bulunamadı: ${id}`);
  const file = join(kbPaths().kb, rel);
  const { data, body } = readDoc<Record<string, unknown>>(file);
  let content = body;
  if (section) {
    const s = getSection(body, section);
    if (s === null) throw new Error(`bölüm bulunamadı: ${section} (${id})`);
    content = s;
  }
  return { id, kind: id.startsWith("T") ? "task" : "finding", file, relative: rel, archived: rel.includes(`/${ARCHIVE}/`), data, content };
}
