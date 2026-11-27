/** `details` satırlarıyla hata; CLI `{"error", "details"}` olarak basar, çıkış 1. Ayrı dosya: cli/ctx.ts her komutta yüklenir, hunter.ts'i çekmesin. */
export class HistoryError extends Error {
  constructor(message: string, public details: string[] = []) {
    super(message);
    this.name = "HistoryError";
  }
}
