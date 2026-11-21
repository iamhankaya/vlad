import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { addressWarning, missingAddressNote } from "../src/agent/addr-check.js";
import { listenWithRetry } from "../src/agent/listen-retry.js";

// F-vlad-368: DHCP ile adres değişince (EADDRNOTAVAIL) neden anlaşılır olsun: günlük ve `vlad status` hangi host'un yok olduğunu ve mevcut adresleri söyler.
const nic = (address: string, o: Partial<NetworkInterfaceInfo> = {}): NetworkInterfaceInfo => ({ address, family: "IPv4", internal: false, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: `${address}/24`, ...o });
const ifaces = { lo0: [nic("127.0.0.1", { internal: true })], en0: [nic("192.168.1.36"), nic("fe80::1", { family: "IPv6" })] };

describe("missingAddressNote", () => {
  it("config'teki IPv4 host bu makinede yoksa host'u ve mevcut adresleri söyler", () => {
    const n = missingAddressNote("192.168.1.34", ifaces)!;
    expect(n).toContain("config'teki host 192.168.1.34 bu makinede yok");
    expect(n).toContain("192.168.1.36");
    expect(n).not.toContain("127.0.0.1"); // loopback önerilmez
  });
  it("host makinede varsa, joker/loopback ya da ad ise null", () => {
    expect(missingAddressNote("192.168.1.36", ifaces)).toBeNull();
    expect(missingAddressNote("0.0.0.0", ifaces)).toBeNull();
    expect(missingAddressNote("127.0.0.1", ifaces)).toBeNull();
    expect(missingAddressNote("mac.local", ifaces)).toBeNull();
  });
  it("hiç dış adres yoksa 'yok' der", () => {
    expect(missingAddressNote("10.0.0.5", { lo0: ifaces.lo0 })).toContain("mevcut adres yok");
  });
});

describe("addressWarning (config + kimlik)", () => {
  const cfg = { brain: "mac", machines: [{ name: "mac", os: "darwin", agent: { host: "192.168.1.34", port: 7437 } }, { name: "win", os: "win32", agent: { host: "192.168.1.50", port: 7437 } }] } as never;
  it("kendi makinenin host'u yoksa uyarı döner", () => {
    expect(addressWarning(cfg, "mac", ifaces)).toContain("192.168.1.34");
  });
  it("bind ayrıysa bind'e bakılır; konsol/bilinmeyen kimlikte null", () => {
    const c2 = { brain: "mac", machines: [{ name: "mac", os: "darwin", agent: { host: "192.168.1.34", bind: "0.0.0.0", port: 7437 } }] } as never;
    expect(addressWarning(c2, "mac", ifaces)).toBeNull(); // joker bind: adres sorunu yok
    expect(addressWarning(cfg, "telefon", ifaces)).toBeNull();
  });
});

describe("listenWithRetry açıklaması", () => {
  it("explain metni EADDRNOTAVAIL günlük satırına eklenir", async () => {
    let n = 0; const logs: string[] = [];
    await listenWithRetry(async () => { if (++n < 2) throw Object.assign(new Error("x"), { code: "EADDRNOTAVAIL" }); return 1; }, { sleep: async () => {}, log: (l) => logs.push(l), explain: () => "config'teki host 1.2.3.4 bu makinede yok; mevcut adres(ler): 5.6.7.8" });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("config'teki host 1.2.3.4 bu makinede yok");
  });
});
