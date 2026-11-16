import type { ApprovalRequestFile, Ctx, DropReason, PendingRecord, RejectReason } from "./types.js";

/**
 * SÖZLEŞME iskeleti (gövdeler U2'de): saf doğrulama/özet/tag/bildirim fonksiyonları; rastgelelik `RandomSource` ile ayrı.
 * İmzalar T20261116-03 planıyla birebir. Golden: test/fixtures/approver/golden-*.json (uygulamadan bağımsız formül).
 */
const todo = (..._a: unknown[]): never => { throw new Error("not implemented"); };

export interface RandomSource { bytes(n: number): Buffer }

/** Allowlist/şema doğrulama (`ARGV_SCHEMA`): bayrak başına tür/arite/enum/boyut; boyut ölçüsü UTF-8 bayt (toplam ≤ LIMITS.maxArgvBytes, değer ≤ maxValueBytes). */
export function validateRequest(raw: unknown): { ok: true; req: ApprovalRequestFile } | { ok: false; reason: RejectReason; detail: string } { return todo(raw); }

/** digest = sha256hex(JSON.stringify(["VLAD-APPROVE1", id, argv, requestedAt, expiresAt, nonce, requester, ctx.home, ctx.kb, ctx.cli])) */
export function computeDigest(p: { id: string; argv: string[]; requestedAt: string; expiresAt: string; nonce: string; requester: string; ctx: Ctx }): string { return todo(p); }
/** hex HMAC-SHA256(key, "VLAD-APPROVE1|"+digest) */
export function approveTag(modeKey: string, digest: string): string { return todo(modeKey, digest); }
/** hex HMAC-SHA256(key, "VLAD-DENY1|"+digest) */
export function denyTag(modeKey: string, digest: string): string { return todo(modeKey, digest); }
/** HMAC(key, "VLAD-GEN1") ilk 16 hex: anahtar nesli (reset/disable/rotate sonrası spawn öncesi yeniden doğrulama). */
export function keyGen(modeKey: string): string { return todo(modeKey); }
/** Gövde `^(a1|d1)\.<id>\.<64 hex>$`; tag servis tarafından yeniden hesaplanır (timingSafeEqual). Geçersiz = `{drop}` (tam kod). */
export function parseDecision(body: string, p: PendingRecord, modeKey: string, now: Date): { decision: "approve" | "deny" } | { drop: DropReason } { return todo(body, p, modeKey, now); }
/** Bildirim şablonu golden ile kilitlidir (ayraç `\n`; `~` kısaltma; `--note` ilk 60 bayt + "…"). */
export function renderNotification(p: PendingRecord): { title: string; message: string } { return todo(p); }

/** 26 karakter base32 (a-z2-7). */
export function newId(r: RandomSource): string { return todo(r); }
/** 32 hex. */
export function newNonce(r: RandomSource): string { return todo(r); }
/** prefix + 26 karakter base32. */
export function newTopic(prefix: "vlad-q-" | "vlad-r-", r: RandomSource): string { return todo(prefix, r); }
