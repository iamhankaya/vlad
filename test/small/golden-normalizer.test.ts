import { describe, expect, it } from "vitest";
import { normalizer } from "../../scripts/lib/golden.mjs";

// Windows tabanı sahte verilir; gerçek dizine dokunulmaz.
const w = { base: "C:\\Users\\x\\t1" };
const norm = normalizer(w, 4242);

describe("golden normalizer: <BASE> sonrası yol ayırıcıları", () => {
  it("JSON içindeki \\\\ ayırıcılar / olur, \\n kaçışı bozulmaz", () => {
    const out = norm('{"p":"C:\\\\Users\\\\x\\\\t1\\\\home\\\\kb\\\\ghost.md\\nsonra"}');
    expect(out).toBe('{"p":"<BASE>/home/kb/ghost.md\\nsonra"}');
  });
  it("düz metindeki \\ ayırıcılar / olur", () => {
    expect(norm("C:\\Users\\x\\t1\\home\\kb\\decisions\\ghost.md bitti")).toBe("<BASE>/home/kb/decisions/ghost.md bitti");
  });
  it("POSIX tabanda çıktı değişmez", () => {
    expect(normalizer({ base: "/tmp/b" }, 1)("/tmp/b/home/kb a\\nb")).toBe("<BASE>/home/kb a\\nb");
  });
});
