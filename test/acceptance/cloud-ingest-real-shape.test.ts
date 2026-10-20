// Doğrulama fazı: gerçek `list_events` çıktı şekliyle (VLAD'ın araç çıktısı) `vlad task ingest`.
// Gerçek şekil: {"ccr":{"data":[{"assistant":{"internal_anthropic_catchall":{"message":{"content":[…]}}}},
// {"result":{"internal_anthropic_catchall":{"result":"<tur sonu metni>"}}}]}}; çevresinde metin zarfı olabilir.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeHome } from "../helpers.js";
import { build, forceRunning, newTask, readTask, taskState, vlad, writeCard } from "./cloud-helpers.js";

let home: string;
let id: string;
beforeAll(build, 120000);
beforeEach(() => {
  home = makeHome();
  writeCard(home, "alpha", { repo: "iamhankaya/vlad" });
  id = newTask(home);
  forceRunning(home, id);
});

const SHA = "a".repeat(40);
const text = () =>
  `[VLAD:LOG #1] adım\n[VLAD:REPORT #2 branch=vlad/${id} head=${SHA}]\n### Yapılanlar\n- örnek\n[VLAD:END #2]`;
const real = () => ({
  ccr: {
    data: [
      { created_at: "2026-10-20T08:29:37Z", assistant: { uuid: "u1", internal_anthropic_catchall: { message: { role: "assistant", content: [{ type: "text", text: text() }] } } } },
      { created_at: "2026-10-20T08:30:00Z", result: { uuid: "u2", internal_anthropic_catchall: { is_error: false, subtype: "success", result: text() } } },
    ],
    has_more: false, first_id: "a", last_id: "b",
  },
});
const ingest = (body: string) => {
  const f = join(home, "real.json");
  writeFileSync(f, body);
  return vlad(home, ["task", "ingest", id, "--events-file", f, "--remote-head", SHA, "--json"]);
};

describe("gerçek list_events şekli", () => {
  it("{ccr:{data:[…]}} sarmalayıcısı ve internal_anthropic_catchall.message okunur", () => {
    const r = ingest(JSON.stringify(real()));
    expect(r.code, r.out + r.err).toBe(0);
    expect(taskState(home, id)).toBe("awaiting_approval");
    expect(readTask(home, id)).toContain("[cloud #1]");
  });

  it("sarmalayıcısız {data:[…]} gerçek olaylarla sessizce 0 işaret işlemez", () => {
    const r = ingest(JSON.stringify(real().ccr));
    expect(r.code, r.out + r.err).toBe(0);
    expect(JSON.parse(r.out).processed.length).toBeGreaterThan(0);
  });

  it("result olayı assistant olayıyla aynı işareti çift işlemez", () => {
    ingest(JSON.stringify(real()));
    const log = readTask(home, id).match(/\[cloud #1\]/g) ?? [];
    expect(log.length).toBe(1);
  });

  it("JSON'un önünde/arkasında metin zarfı olsa da okunur", () => {
    const r = ingest(`Output of list_events:\n${JSON.stringify(real())}\n(end of output)\n`);
    expect(r.code, r.out + r.err).toBe(0);
    expect(taskState(home, id)).toBe("awaiting_approval");
  });
});
