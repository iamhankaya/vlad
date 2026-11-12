import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { kbPaths } from "./home.js";

/** İşçiye taşınabilir oturum adı: tek satır, boşluksuz (VLAD_SESSION env'ine girer). */
export const SESSION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const sessionFile = (): string => join(kbPaths().kb, "vlad-session.txt");

/** Bu makinenin kb'sindeki kayıtlı oturum adı (`vlad session register`); yoksa null. */
export function readSessionFile(): string | null {
  const f = sessionFile();
  if (!existsSync(f)) return null;
  return readFileSync(f, "utf8").trim() || null;
}

/**
 * F-vlad-199: uzak işçide vlad-session.txt makineye yerel ve eskidir; beyin adı launch ile `VLAD_SESSION` env'i olarak verir,
 * o varsa dosyadan önce gelir.
 */
export const sessionName = (): string | null => process.env.VLAD_SESSION?.trim() || readSessionFile();
