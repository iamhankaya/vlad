import { describe, expect, it } from "vitest";
import { OP_TABLE } from "../../src/agent/ops/index.js";
import { PROBE_TITLE, probeWindow, probeWindowCommand } from "../../src/agent/ops/probe-window.js";
import { RemoteError } from "../../src/machines/index.js";

describe("machines:C2 probe-window", () => {
  it("komut sabittir: kullanıcı girdisi yok, başlık sabit, pencere kendiliğinden kapanır (-NoExit yok)", () => {
    const { file, args } = probeWindowCommand();
    expect(file).toBe("powershell.exe");
    expect(args).not.toContain("-NoExit");
    const script = args[args.length - 1];
    expect(script).toContain(PROBE_TITLE);
    expect(script).toMatch(/Start-Sleep/);
    expect(probeWindowCommand()).toEqual({ file, args });
  });

  it("win32: enjekte exec'e tam bir kez sabit komutla gider, {opened,method} döner", async () => {
    const calls: { file: string; args: string[] }[] = [];
    const r = await probeWindow({ platform: "win32", exec: async (file, args) => { calls.push({ file, args }); } });
    expect(r).toEqual({ opened: true, method: "wmi-powershell" });
    expect(calls).toEqual([probeWindowCommand()]);
  });

  it("exec hatası RemoteError(failed) olur ve iletiyi taşır", async () => {
    const p = probeWindow({ platform: "win32", exec: async () => { throw new Error("Win32_Process.Create başarısız (kod 8)"); } });
    await expect(p).rejects.toBeInstanceOf(RemoteError);
    await expect(p).rejects.toMatchObject({ code: "failed", message: expect.stringContaining("kod 8") });
  });

  it("win32 dışında pencere denenmez (exec çağrılmaz)", async () => {
    let n = 0;
    await expect(probeWindow({ platform: "darwin", exec: async () => { n++; } })).rejects.toMatchObject({ code: "failed", message: expect.stringContaining("yalnız Windows") });
    expect(n).toBe(0);
  });

  it("op tablosuna bağlı; VLAD_LAUNCHER=noop korumasında gerçek pencere AÇILMAZ ve failed döner", async () => {
    expect(process.env.VLAD_LAUNCHER).toBe("noop");
    await expect(OP_TABLE["probe-window"]({}, { from: "mac", opId: "o1" })).rejects.toMatchObject({ code: "failed" });
  });
});
