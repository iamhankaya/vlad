import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("kb salt okuma: metin sözleşmesi (T20261026-20)", () => {
  it("delegate 5a-cloud: create_session öncesi kb push, extra_allowed_tools aynen, inline yedek", () => {
    const d = read(".claude/skills/delegate/SKILL.md");
    expect(d).toMatch(/`create_session`'dan önce `vlad kb commit[^`]*--push`/);
    expect(d).toMatch(/`extra_allowed_tools`[^.]*\*\*aynen\*\*/);
    expect(d).toMatch(/kb erişimi yok/);
    expect(d).toMatch(/cloudKb: .inline./);
  });

  it("status: ingest/status başında vlad kb check, --ack ve kb erişimi yok yanıtı", () => {
    const s = read(".claude/skills/status/SKILL.md");
    expect(s).toMatch(/vlad kb check --json/);
    expect(s).toMatch(/vlad kb check --ack <head>/);
    expect(s).toMatch(/\[VLAD:LOG\] kb erişimi yok/);
    expect(s).toMatch(/cloudKb: .inline./);
  });

  it("vlad-worker: bulut çalışanı için klon salt okuma, push yok, pull yalnız VLAD isteyince", () => {
    const w = read("global/skills/vlad-worker/SKILL.md");
    expect(w).toMatch(/kb salt okuma \(bulut\)/);
    expect(w).toMatch(/commit\/push yok/);
    expect(w).toMatch(/git pull --ff-only` yalnız VLAD/);
  });

  it("CLAUDE.md: salt okuma + vlad kb check cümlesi ve komut listesi", () => {
    const c = read("CLAUDE.md");
    expect(c).toMatch(/Bulut çalışanları kb'yi salt okuma ekler; yazma yalnız VLAD'dır ve yabancı commit `vlad kb check` ile izlenir/);
    expect(c).toMatch(/`vlad kb commit\|check`/);
  });

  it(".claude/settings.json: geçerli JSON, izin listesi yalnız add_repo ve register_repo_root, hook korunur", () => {
    const j = JSON.parse(read(".claude/settings.json"));
    expect(j.permissions.allow).toEqual([
      "mcp__claude-code-remote__add_repo",
      "mcp__claude-code-remote__register_repo_root",
    ]);
    expect(j.hooks.SessionStart).toBeDefined();
  });
});
