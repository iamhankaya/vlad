import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { remoteErrorDetails } from "../../src/machines/exit.js";
import { RemoteError, type RemoteTransport } from "../../src/fleet/types.js";
import { checkEntryNames, sendPaths } from "../../src/transfer/send.js";
import { rmTemp } from "../helpers.js";

const temps: string[] = [];
afterEach(() => { for (const t of temps.splice(0)) rmTemp(t); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "vlad-cnames-")); temps.push(d); return d; };
const dead: RemoteTransport = { async call() { throw new Error("ağa çıkılmamalı"); } };

describe("aktarim:C F-vlad-221 gönderici ad denetimi", () => {
  it("checkEntryNames: alıcıyla aynı kurallar, sorunlu yol + neden listelenir", () => {
    expect(checkEntryNames(["ok.txt", "d/içeri.txt"], "win32")).toEqual([]);
    expect(checkEntryNames(["a:b"], "darwin")).toEqual([{ path: "a:b", reason: "ters eğik çizgi veya iki nokta" }]);
    expect(checkEntryNames(["x/CON.txt"], "win32")[0]).toMatchObject({ path: "x/CON.txt", reason: "Windows ayrılmış adı" });
    expect(checkEntryNames(["x/CON.txt"], "darwin")).toEqual([]);
    expect(checkEntryNames(["a."], "win32")[0]!.reason).toMatch(/nokta/);
    expect(checkEntryNames(["a."], "darwin")).toEqual([]);
  });
  it("checkEntryNames: harf duyarsız (NFC) çakışma", () => {
    const r = checkEntryNames(["d/a.txt", "d/A.TXT", "d/b"], "darwin");
    expect(r).toHaveLength(1); expect(r[0]).toMatchObject({ path: "d/A.TXT" }); expect(r[0]!.reason).toMatch(/çakış/);
    expect(checkEntryNames(["é", "é"], "darwin")).toHaveLength(1);
  });
  it("sendPaths: sorunlu ad ağa çıkmadan bad_request; details'ta yol", async () => {
    const d = join(tmp(), "proje"); mkdirSync(d); writeFileSync(join(d, "iyi.txt"), "x"); writeFileSync(join(d, "kötü:ad.txt"), "x");
    const e = await sendPaths(dead, { to: "windows", paths: [d], peerOs: "win32" }).then(() => null, (x) => x);
    expect(e).toBeInstanceOf(RemoteError); expect(e.code).toBe("bad_request");
    expect(e.message).toMatch(/kötü:ad\.txt/);
    expect(remoteErrorDetails(e)).toContain("path: proje/kötü:ad.txt");
  });
  it("sendPaths: Windows hedefinde yalnız Windows'ta yasak ad reddedilir, Mac hedefinde geçer", async () => {
    const f = join(tmp(), "nul.txt"); writeFileSync(f, "x");
    const e = await sendPaths(dead, { to: "w", paths: [f], peerOs: "win32" }).then(() => null, (x) => x);
    expect(e.code).toBe("bad_request");
    const e2 = await sendPaths(dead, { to: "m", paths: [f], peerOs: "darwin" }).then(() => null, (x) => x);
    expect(e2.message).toMatch(/ağa çıkılmamalı/); // denetimden geçti, ping'e gitti
  });
});
