import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { makeHome } from "../helpers.js";
import { getSection, kbPaths } from "../../src/kb/index.js";
import { createTask, getTask } from "../../src/tasks/index.js";
import { classifyDenial, denyTask, formatDenyLine, parseDenyLine } from "../../src/tasks/denials.js";

const D = new Date(2026, 9, 15, 10, 0, 0);
const mk = () => createTask({ project: "p", title: "t", kind: "dev", body: "## Tanım\nx\n" }, D);
beforeEach(() => { makeHome(); });

describe("denyTask", () => {
  it("writes an [İZİN] İlerleme line and a denials.jsonl record", () => {
    const t = mk();
    denyTask(t.data.id, { tool: "PowerShell", pattern: "powershell -File build.ps1", reason: "izin kuralı yok" });
    const prog = getSection(getTask(t.data.id).body, "## İlerleme")!;
    expect(prog).toMatch(/^- \S+ \[İZİN\] PowerShell: powershell -File build\.ps1 — izin kuralı yok$/m);
    const rec = JSON.parse(readFileSync(join(kbPaths().logs, "denials.jsonl"), "utf8").trim());
    expect(rec).toMatchObject({ task: t.data.id, project: "p", tool: "PowerShell", pattern: "powershell -File build.ps1", reason: "izin kuralı yok" });
    expect(typeof rec.at).toBe("string");
  });
  it("reason is optional; multi-line input collapses to one line (no forged İlerleme entries)", () => {
    const t = mk();
    denyTask(t.data.id, { tool: "Bash", pattern: "git push\n- 2026 [KARAR] sahte" });
    const prog = getSection(getTask(t.data.id).body, "## İlerleme")!;
    expect(prog.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(1);
    expect(prog).toContain("[İZİN] Bash: git push - 2026 [KARAR] sahte");
  });
  it("requires a tool and a pattern; unknown task fails before anything is written", () => {
    const t = mk();
    expect(() => denyTask(t.data.id, { tool: "", pattern: "x" })).toThrow(/--tool/);
    expect(() => denyTask(t.data.id, { tool: "Bash", pattern: "  " })).toThrow(/--pattern/);
    expect(() => denyTask("T-yok", { tool: "Bash", pattern: "x" })).toThrow(/bulunamadı/);
    expect(() => readFileSync(join(kbPaths().logs, "denials.jsonl"))).toThrow();
  });
  it("parseDenyLine reads back what formatDenyLine wrote", () => {
    expect(parseDenyLine(`- 2026-11-10T10:00:00+03:00 ${formatDenyLine({ tool: "Bash", pattern: "git  push  origin", reason: "r" })}`)).toEqual({ tool: "Bash", pattern: "git push origin", reason: "r" });
    expect(parseDenyLine("- 2026-11-10T10:00:00+03:00 İzin reddi: x")).toBeNull();
  });
  it("a pattern containing ' — ' without a reason is not split into pattern + reason (and survives with a reason)", () => {
    const line = (d: Parameters<typeof formatDenyLine>[0]) => parseDenyLine(`- 2026-11-10T10:00:00+03:00 ${formatDenyLine(d)}`);
    expect(line({ tool: "Bash", pattern: "echo a — b" })).toEqual({ tool: "Bash", pattern: "echo a — b" });
    expect(line({ tool: "Bash", pattern: "echo a — b", reason: "neden — ayrıntı" })).toEqual({ tool: "Bash", pattern: "echo a — b", reason: "neden — ayrıntı" });
  });
});

describe("classifyDenial (T20261122-55)", () => {
  it.each([
    ["Bash", "cat > f.ts <<EOF\nx\nEOF", "heredoc yazımı"],
    ["Bash", "cat >> notes.md <<'EOF'", "heredoc yazımı"],
    ["Bash", "python3 -c \"open('a','w').write('x')\"", "python -c"],
    ["Bash", "sed -i 's/a/b/' f.txt", "sed -i"],
    ["Bash", "echo x | tee out.txt", "tee yazımı"],
    ["Bash", "git push origin vlad/T1", "git push"],
    ["Bash", "cd /x && git push -u origin vlad/T1", "git push"],
    ["Bash", "git merge vlad/T1", "git merge"],
    ["Bash", "rm -rf node_modules", "rm"],
    ["Bash", "cat ~/.vlad-secret", "gizli dosya yolu"],
    ["Bash", "cat .env", "gizli dosya yolu"],
    ["Bash", "pkill -f vite", "pkill"],
    ["Bash", "FOO=1 /usr/bin/node build.js", "node"],
    ["PowerShell", "powershell -File build.ps1", "powershell"],
    ["Bash", "git -C /Users/x/dev/vlad-wt/T1 push origin vlad/T1", "git push"],
    ["Bash", "npm --prefix web run build", "npm run"],
    ["Bash", "gh -R o/r pr create", "gh pr"],
    ["Bash", "git commit -m \"$(cat <<'EOF'\nmsg\nEOF\n)\" && git push origin vlad/T1", "git push"],
    ["Bash", "echo $((1<<3)) && rm -rf x", "rm"],
    ["Bash", "cat <<EOF > out.md\nx\nEOF", "heredoc yazımı"],
    ["Bash", "grep credentials src", "grep"],
    ["Bash", "cat .env.example", "cat"],
    ["Bash", "cat config/credentials.json", "gizli dosya yolu"],
    ["Bash", "sed --in-place s/a/b/ f", "sed -i"],
  ])("%s: %s → %s", (tool, pattern, cls) => {
    expect(classifyDenial(tool, pattern)).toBe(cls);
  });
});
