import { chmodSync, closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

/**
 * Uzaktan onay spool'u için güvenli dosya işlemleri (yol parametreli; token.ts'e bağımlı değil).
 * Koruma kapsamı: yanlış yapılandırma ve sembolik bağ/hardlink/FIFO yanılgıları. AYNI UID'deki kötü niyetli sürece karşı tam koruma DEĞİLDİR.
 * POSIX izin/sahip denetimleri Windows'ta atlanır (Windows kapsam dışı, F-vlad-338).
 */
const posix = process.platform !== "win32";
const uid = (): number => (typeof process.getuid === "function" ? process.getuid() : -1);

/** İstek/kimlik adı: 128 bit base32 (traversal ve büyük harf yok). */
export const NAME_RE = { id: /^[a-z2-7]{26}$/, cid: /^[a-z2-7]{26}$/ } as const;

/** lstat: dizin, sembolik bağ değil, sahibi biz, mod 0700; yoksa 0700 oluşturur. Üst dizin: dizin, başkası yazamaz (sticky hariç). */
export function assertSecureDir(path: string): void {
  const parent = dirname(path);
  const ps = statSync(parent);
  if (!ps.isDirectory()) throw new Error(`üst dizin dizin değil: ${parent}`);
  if (posix && (ps.mode & 0o022) && !(ps.mode & 0o1000)) throw new Error(`üst dizin başkası tarafından yazılabilir (sticky değil): ${parent}`);
  let st;
  try { st = lstatSync(path); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    mkdirSync(path, { mode: 0o700 });
    chmodSync(path, 0o700);
    return;
  }
  if (st.isSymbolicLink()) throw new Error(`sembolik bağ: ${path}`);
  if (!st.isDirectory()) throw new Error(`dizin değil: ${path}`);
  if (posix && st.uid !== uid()) throw new Error(`dizin sahibi biz değiliz: ${path}`);
  if (posix && (st.mode & 0o777) !== 0o700) throw new Error(`dizin izni 0700 olmalı: ${path}`);
}

/** fd tabanlı okuma: O_NOFOLLOW (FIFO'da bloklamamak için O_NONBLOCK), düzenli dosya, nlink==1, sahip, mod 0600, boyut ≤ maxBytes. */
export function readSecureFile(path: string, maxBytes: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (posix ? constants.O_NONBLOCK : 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`düzenli dosya değil: ${path}`);
    // writeAtomic(overwrite:false) link→unlink arasında nlink kısa süre 2 olur: kısa yeniden deneme (kalıcı hardlink yine reddedilir)
    for (let i = 0; i < 5 && fstatSync(fd).nlink === 2; i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    if (fstatSync(fd).nlink !== 1) throw new Error(`nlink != 1 (hardlink): ${path}`);
    if (posix && st.uid !== uid()) throw new Error(`dosya sahibi biz değiliz: ${path}`);
    if (posix && (st.mode & 0o777) !== 0o600) throw new Error(`dosya izni 0600 olmalı: ${path}`);
    if (st.size > maxBytes) throw new Error(`boyut sınırı aşıldı (${st.size} > ${maxBytes}): ${path}`);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, off); if (n === 0) break; off += n; }
    return buf.subarray(0, off);
  } finally { closeSync(fd); }
}

/** Geçici dosya (wx, 0600) + fsync + yayınlama. overwrite:false ise mevcut hedefte fırlatır (EEXIST; hardlink ile atomik), true ise rename. Dizin fsync'i en iyi çaba. */
export function writeAtomic(path: string, data: string | Buffer, opts: { overwrite?: boolean } = {}): void {
  const tmp = join(dirname(path), `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    const b = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    let off = 0;
    while (off < b.length) off += writeSync(fd, b, off, b.length - off);
    fsyncSync(fd);
  } catch (e) { closeSync(fd); try { unlinkSync(tmp); } catch { /* temizlik en iyi çaba */ } throw e; }
  closeSync(fd);
  try {
    if (opts.overwrite) renameSync(tmp, path);
    else linkSync(tmp, path); // shortcut: hardlink'siz dosya sisteminde (EPERM/ENOTSUP) başarısız olur; macOS APFS/ev dizini için yeterli
  } catch (e) { try { unlinkSync(tmp); } catch { /* temizlik en iyi çaba */ } throw e; }
  if (!opts.overwrite) { try { unlinkSync(tmp); } catch { /* hedef yayınlandı; artık temp en iyi çaba silinir */ } }
  try { const d = openSync(dirname(path), constants.O_RDONLY); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* en iyi çaba */ }
}
