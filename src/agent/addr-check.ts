import { isIPv4 } from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import type { VladConfig } from "../kb/types.js";

type Ifaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

const WILDCARD_OR_LOOPBACK = (h: string): boolean => h === "0.0.0.0" || h.startsWith("127.");

/**
 * F-vlad-368: DHCP ile makinenin IP'si değişirse config'teki host artık bu makinede yoktur (EADDRNOTAVAIL).
 * Yalnız IPv4 sayısal host denetlenir (ad/joker/loopback: null). Mevcut dış IPv4 adresleri önerilir.
 */
export function missingAddressNote(host: string, ifaces: Ifaces = networkInterfaces()): string | null {
  if (!isIPv4(host) || WILDCARD_OR_LOOPBACK(host)) return null;
  const mine = Object.values(ifaces).flatMap((l) => l ?? []).filter((i) => i.family === "IPv4" && !i.internal).map((i) => i.address);
  if (mine.includes(host)) return null;
  return `config'teki host ${host} bu makinede yok; ${mine.length ? `mevcut adres(ler): ${mine.join(", ")}` : "mevcut adres yok (ağ bağlı mı?)"}`;
}

/** Kendi Agent adresimiz (bind, yoksa host) için uyarı; kimlik makine değilse ya da sorun yoksa null. */
export function addressWarning(cfg: VladConfig, self: string, ifaces?: Ifaces): string | null {
  const def = cfg.machines?.find((m) => m.name === self);
  if (!def) return null;
  const host = def.agent.bind ?? def.agent.host;
  return host ? missingAddressNote(host, ifaces) : null;
}
