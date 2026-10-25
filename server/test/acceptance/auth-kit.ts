// T6 kabul testleri için bağımsız yardımcılar. Yalnız arayüzden beslenir: `buildApp` (HTTP), `PairingCodes.issue()` (CLI `vlad-server pair`
// ile aynı kod üretimi; sahte saatle süre testi için tek yol), `contract/README.md` zarf/iptal kuralları. Zarf ve DER kodlaması burada
// kontrattan yeniden yazılmıştır (S6b'nin `auth/*` modüllerinden ya da test yardımcılarından kopyalanmaz).
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { PairingCodes } from "../../src/auth/pairing.ts";
import { buildApp, type AppConfig } from "../../src/http/app.ts";

export const CONTRACT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contract");
export const vectors = JSON.parse(readFileSync(join(CONTRACT, "signing-vectors.json"), "utf8"));
export const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
export const sha256hex = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Saat "şimdi"ye göre başlar (sabit takvim tarihi yok); testler `t` alanını ilerletir. */
export class Clock {
  t = Date.now();
  now = () => this.t;
}

const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

const derInt = (x: bigint): Buffer => {
  let h = x.toString(16);
  if (h.length % 2) h = "0" + h;
  let b = Buffer.from(h, "hex");
  if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return Buffer.concat([Buffer.from([0x02, b.length]), b]);
};
const derSig = (r: bigint, s: bigint): Buffer => {
  const body = Buffer.concat([derInt(r), derInt(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
};

/** ECDSA P-256 SHA-256, minimal DER, low-S (istemcinin üretmesi gereken biçim). */
export function signLowS(priv: KeyObject, msg: string | Uint8Array): string {
  const raw = sign("sha256", Buffer.from(msg), { key: priv, dsaEncoding: "ieee-p1363" });
  const r = BigInt("0x" + raw.subarray(0, 32).toString("hex"));
  let s = BigInt("0x" + raw.subarray(32).toString("hex"));
  if (s > N >> 1n) s = N - s;
  return b64u(derSig(r, s));
}
/** Aynı mesaj için geçerli ama yüksek-S ikiz. */
export function signHighS(priv: KeyObject, msg: string | Uint8Array): string {
  const raw = sign("sha256", Buffer.from(msg), { key: priv, dsaEncoding: "ieee-p1363" });
  const r = BigInt("0x" + raw.subarray(0, 32).toString("hex"));
  let s = BigInt("0x" + raw.subarray(32).toString("hex"));
  if (s <= N >> 1n) s = N - s;
  return b64u(derSig(r, s));
}
export function signRawRS(priv: KeyObject, msg: string | Uint8Array): string {
  return b64u(sign("sha256", Buffer.from(msg), { key: priv, dsaEncoding: "ieee-p1363" }));
}

export const newNonce = () => randomBytes(16).toString("base64url");

/** Kanonik sorgu: `k=v` çiftleri anahtara göre UTF-8 bayt sırasıyla; testler zaten sıralı/ASCII verir. */
export function envelope(method: string, path: string, rawQuery: string, ts: number, nonce: string, body: string | Uint8Array = ""): string {
  const q = rawQuery
    ? "?" +
      rawQuery
        .split("&")
        .filter(Boolean)
        .map((p) => (p.includes("=") ? p : p + "="))
        .sort((a, b) => Buffer.compare(Buffer.from(a.split("=")[0]!), Buffer.from(b.split("=")[0]!)))
        .join("&")
    : "";
  return `v1\n${method}\n${path}${q}\n${ts}\n${nonce}\n${sha256hex(body)}`;
}

export const revokeText = (device: string, signer: string, ts: number) => `vlad-revoke/v1\ndevice=${device}\nsigner=${signer}\nts=${ts}`;

export const genKey = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { priv: privateKey, pub: b64u(publicKey.export({ format: "der", type: "spki" })) };
};

export type Key = ReturnType<typeof genKey>;

export class Phone {
  session: Key;
  approval: Key;
  id = "";
  name: string;
  constructor(name = "Pixel 9", session = genKey(), approval = genKey()) {
    this.name = name;
    this.session = session;
    this.approval = approval;
  }

  /** İmzalı başlıklar. `target` ham hedeftir (yol + isteğe bağlı sorgu), olduğu gibi imzalanır. */
  headers(clock: Clock, method: string, target: string, body: string | Uint8Array = "", o: { ts?: number; nonce?: string; device?: string; sig?: (priv: KeyObject, msg: string) => string; key?: KeyObject } = {}) {
    const q = target.indexOf("?");
    const ts = o.ts ?? clock.t;
    const nonce = o.nonce ?? newNonce();
    const msg = envelope(method, q < 0 ? target : target.slice(0, q), q < 0 ? "" : target.slice(q + 1), ts, nonce, body);
    const signer = o.sig ?? signLowS;
    return { "x-vlad-device": o.device ?? this.id, "x-vlad-ts": String(ts), "x-vlad-nonce": nonce, "x-vlad-sig": signer(o.key ?? this.session.priv, msg) };
  }
}

export type Rig = { app: FastifyInstance; clock: Clock; dir: string; cfg: AppConfig; restart: () => Rig };

export function rig(over: Partial<AppConfig> = {}, dir = mkdtempSync(join(tmpdir(), "vlad-acc-")), clock = new Clock()): Rig {
  const cfg: AppConfig = { stateDir: dir, version: "0.0.0-acc", now: clock.now, ...over };
  return { app: buildApp(cfg), clock, dir, cfg, restart: () => rig(over, dir, clock) };
}

export const issueCode = (r: Rig) => new PairingCodes(r.dir, r.clock.now).issue().code;

export const pairBody = (code: string, p: Phone, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ code, device_name: p.name, session_pub: p.session.pub, approval_pub: p.approval.pub, ...extra });

export const postPair = (r: Rig, payload: string) =>
  r.app.inject({ method: "POST", url: "/v1/pair", headers: { "content-type": "application/json" }, payload });

export async function pair(r: Rig, p = new Phone()): Promise<Phone> {
  const res = await postPair(r, pairBody(issueCode(r), p));
  if (res.statusCode !== 200) throw new Error(`pair failed ${res.statusCode} ${res.body}`);
  p.id = res.json().device_id;
  return p;
}

export async function call(r: Rig, p: Phone, method: string, target: string, body?: string, o?: Parameters<Phone["headers"]>[4]) {
  const h = p.headers(r.clock, method, target, body ?? "", o);
  return r.app.inject({ method: method as "GET", url: target, headers: { ...h, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { payload: body } : {}) });
}

/** İstek zarfı kabul edildi mi: auth reddi (400/401/429) dışında herhangi bir yanıt (uçlar henüz taslak olabilir). */
export const passedAuth = (status: number, body?: string) => {
  if (status === 401 || status === 429) return false;
  if (status !== 400) return true;
  // 400: yalnız işleyici kaynaklıysa (details.field/reason) auth geçmiştir; zarf/imza aşaması 400'ü ayrıntısızdır.
  try {
    const d = JSON.parse(body ?? "")?.error?.details;
    return typeof d?.field === "string" || typeof d?.reason === "string";
  } catch {
    return false;
  }
};

export const GOOD_TARGET = "/v1/home";

export type RawRes = { status: number; headers: http.IncomingHttpHeaders; body: string };

/** Ham HTTP isteği: istek satırını olduğu gibi gönderir (absolute-form, HEAD, OPTIONS, yinelenen başlık, gövdeli GET). */
export async function rawHttp(app: FastifyInstance, o: { method: string; target: string; headers?: Record<string, string | string[]>; body?: string; rawHead?: string }): Promise<RawRes> {
  if (!app.server.listening) await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  const headers: Record<string, string | string[]> = { ...(o.headers ?? {}) };
  const has = (n: string) => Object.keys(headers).some((k) => k.toLowerCase() === n);
  if (o.body !== undefined && !has("content-length") && !has("transfer-encoding")) headers["content-length"] = String(Buffer.byteLength(o.body));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: o.method, path: o.target, headers, insecureHTTPParser: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

export const errCode = (body: string): string | undefined => {
  try {
    return JSON.parse(body)?.error?.code;
  } catch {
    return undefined;
  }
};

/** Akış (SSE) uçları için: gerçek soketle bağlanır, yalnız durum satırı ve başlıkları okur, bağlantıyı keser (gövde beklenmez). */
export async function headersOnly(app: FastifyInstance, target: string, headers: Record<string, string>): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  if (!app.server.listening) await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "GET", path: target, headers }, (res) => {
      const out = { status: res.statusCode ?? 0, headers: res.headers };
      res.destroy();
      req.destroy();
      resolve(out);
    });
    req.on("error", (e) => (req.destroyed ? undefined : reject(e)));
    req.end();
  });
}
