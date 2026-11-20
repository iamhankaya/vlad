/**
 * F-vlad-358: bağlanma adresi yokken (EADDRNOTAVAIL; ör. başka ağa geçiş) Agent çıkıp launchd KeepAlive döngüsüne girmesin ve
 * agent.log dönüp geçmişi silmesin: geri çekilmeli (baseMs → maxMs) bekler, hatayı tek satır yazar. Başka hatalar hemen fırlar.
 */
export interface RetryOpts { sleep?: (ms: number) => Promise<void>; log: (line: string) => void; baseMs?: number; maxMs?: number; signal?: AbortSignal }

export async function listenWithRetry<T>(fn: () => Promise<T>, o: RetryOpts): Promise<T> {
  // Varsayılan uyku iptal sinyaliyle kesilir (SIGTERM'de ≤ 60 sn gecikme olmasın); enjekte `sleep` aynen kullanılır.
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => {
    if (o.signal?.aborted) return r();
    const done = (): void => { clearTimeout(t); o.signal?.removeEventListener("abort", done); r(); };
    const t = setTimeout(done, ms);
    o.signal?.addEventListener("abort", done, { once: true });
  }));
  const base = o.baseMs ?? 1000, max = o.maxMs ?? 60_000;
  let delay = base, warned = false;
  for (;;) {
    try { return await fn(); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRNOTAVAIL" || o.signal?.aborted) throw e;
      if (!warned) { warned = true; o.log(`agent: bağlanma adresi şu an yok (EADDRNOTAVAIL); geri çekilmeyle yeniden denenecek (≤ ${Math.round(max / 1000)} sn aralık)`); }
      await sleep(delay);
      if (o.signal?.aborted) throw e;
      delay = Math.min(delay * 2, max);
    }
  }
}
