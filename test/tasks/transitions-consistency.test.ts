import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskState } from "../../src/kb/index.js";
import { answerTask, askTask, createTask, getTask, reportTask, saveTask, setState, TRANSITIONS } from "../../src/tasks/index.js";
import { makeHome, rmTemp } from "../helpers.js";

let home: string;
beforeEach(() => { home = makeHome(); });
afterEach(() => rmTemp(home));

const STATES = Object.keys(TRANSITIONS) as TaskState[];
function taskIn(state: TaskState) {
  const t = createTask({ project: "alpha", title: "t", kind: "dev", body: "## Tanım\nx\n" });
  t.data.state = state;
  saveTask(t);
  return t.data.id;
}

// F-vlad-238/239: every state-changing command honours the §5.2 table; answer is stricter (blocked only).
const CMDS: { name: string; to: TaskState; allowedFrom: TaskState[]; run: (id: string) => unknown }[] = [
  { name: "ask", to: "blocked", allowedFrom: STATES.filter((s) => TRANSITIONS[s].includes("blocked")), run: (id) => askTask(id, "q") },
  { name: "report", to: "awaiting_approval", allowedFrom: STATES.filter((s) => TRANSITIONS[s].includes("awaiting_approval")), run: (id) => reportTask(id, "### Yapılanlar\nx") },
  { name: "answer", to: "running", allowedFrom: ["blocked"], run: (id) => answerTask(id, "a") },
  { name: "set (→ queued)", to: "queued", allowedFrom: STATES.filter((s) => TRANSITIONS[s].includes("queued")), run: (id) => setState(id, "queued") },
];

describe("durum değiştiren komutlar geçiş tablosuyla tutarlı", () => {
  for (const c of CMDS) {
    for (const s of STATES) {
      const ok = c.allowedFrom.includes(s);
      it(`${c.name} ${s} görevde ${ok ? "geçer" : "reddedilir ve dosya değişmez"}`, () => {
        const id = taskIn(s);
        const path = getTask(id).file;
        const before = readFileSync(path, "utf8");
        if (ok) {
          c.run(id);
          expect(getTask(id).data.state).toBe(c.to);
        } else {
          expect(() => c.run(id)).toThrow();
          expect(readFileSync(path, "utf8")).toBe(before);
        }
      });
    }
  }
});
