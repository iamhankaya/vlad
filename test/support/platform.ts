/** Windows'ta çalışmayan POSIX varsayımları için ortak bayraklar (`it.skipIf(IS_WIN)`; her kullanımda nedeni yorumla yaz). */
export const IS_WIN = process.platform === "win32";
