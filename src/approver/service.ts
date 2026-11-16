import type { ApproverChannel } from "./ntfy.js";
import type { Executor } from "./exec.js";
import type { RandomSource } from "./request.js";
import type { Store } from "./store.js";

/**
 * SÖZLEŞME iskeleti (gövde U4'te). Servis durum makinesi: pending → approved → executing → (ResultRecord); pending → denied|expired.
 * Kurallar (plan "Protokol"): inbox→claimed `rename` sahiplenme, ack, kontrol sırası invalid→key_disabled→locked→busy→rate_limited, `ready` olmadan yayın yok,
 * karar tüketimi tek senkron blokta (ilk geçerli karar kazanır), kurtarma hiçbir durumda yeniden çalıştırmaz (`interrupted`), spawn öncesi keyGen/ctx yeniden doğrulama.
 * Test seam kuralı: Executor/Clock/RandomSource enjeksiyonu yalnız bu `deps`'ten gelir; üretim `approver run` sabit deps kurar, `VLAD_*` env'den seam okumaz.
 */
export interface Clock { now(): Date }
export interface ApproverDeps { channel: ApproverChannel; clock: Clock; random: RandomSource; executor: Executor; store: Store; log(l: string): void; signal: AbortSignal }

/** Başlangıçta: service.lock al, kurtarma (approved/executing → interrupted, spawn ÇAĞRILMAZ; süresi dolan pending → expired). */
export function runApprover(deps: ApproverDeps): Promise<void> { void deps; throw new Error("not implemented"); }
