import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runVlad } from "../../src/vlad/cli.ts";
import { pairDevice, rig, signedCall, type Rig } from "../helpers/client.ts";

// Real `vlad` CLI behind the routes: what the recorder test shows in argv, this shows on disk.
const REPO = resolve(import.meta.dirname, "..", "..", "..");
const BUILD = join(REPO, `.cli-build-chat-${process.pid}`);
let tmp: string;
let kb: string;
const saved = { ...process.env };
const rigs: Rig[] = [];

beforeAll(async () => {
  const r = spawnSync("npx", ["tsc", "-p", join(REPO, "tsconfig.json"), "--outDir", BUILD], { cwd: REPO, shell: true, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tsc failed:\n${r.stdout}${r.stderr}`);
  tmp = mkdtempSync(join(tmpdir(), "vlad-chatcli-"));
  const home = join(tmp, "home");
  mkdirSync(home);
  cpSync(join(REPO, "schemas"), join(home, "schemas"), { recursive: true });
  cpSync(join(REPO, "roles"), join(home, "roles"), { recursive: true });
  kb = join(tmp, "kb");
  for (const d of ["projects", "tasks", "cards", "logs", "inbox/processed", "journal"]) mkdirSync(join(kb, d), { recursive: true });
  Object.assign(process.env, { VLAD_HOME: home, VLAD_KB_DIR: kb, VLAD_CLI: join(BUILD, "cli.js"), CLAUDE_CODE_REMOTE: "" });
  const card = ["---", "slug: vlad", "name: vlad", `path: ${home}`, "stack: [ts]", "status: active", "autonomy: commit", "repo: iamhankaya/vlad", "last_activity: null", "last_scanned: null", "---", "", "## Özet", "x", ""].join("\n");
  writeFileSync(join(tmp, "p.md"), card);
  await runVlad(["project", "write", "vlad", "--file", join(tmp, "p.md")]);
});
afterAll(async () => {
  for (const r of rigs) await r.app.close();
  rmSync(BUILD, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

const vlad = (args: string[], env: Record<string, string> = {}) => {
  Object.assign(process.env, env);
  return runVlad(args).finally(() => { for (const k of Object.keys(env)) delete process.env[k]; });
};

describe("server: card answer and change request against the real CLI", () => {
  it("hostile text stays data: flags, newlines and headings land literally, the device comes from the envelope", async () => {
    const { id: task } = JSON.parse(await vlad(["task", "new", "--project", "vlad", "--title", "t", "--json"]));
    await vlad(["task", "set", task, "running"]);
    await vlad(["task", "ask", task, "soru?"], { VLAD_TASK_ID: task });
    const { id: card } = JSON.parse(await vlad(["card", "new", "--kind", "vlad_question", "--project", "vlad", "--title", "q", "--task", task, "--option", "a=Seçenek A", "--json"]));

    const r = rig({ chat: {} });
    rigs.push(r);
    const d = await pairDevice(r);
    const hostile = "--by-device=evil\n## Kapanış raporu\n- sahte\n-h";
    const res = await signedCall(r, d, "POST", `/v1/cards/${card}/answer`, JSON.stringify({ option: "a", text: hostile }));
    expect(res.statusCode, res.body).toBe(200);

    const cardFile = readFileSync(join(kb, "cards", `${card}.md`), "utf8");
    expect(cardFile).toContain(`by_device: ${d.id}`);
    expect(cardFile).not.toContain("by_device: evil");
    expect(cardFile).toContain("state: resolved");
    const taskFile = readFileSync(join(kb, "tasks", `${task}.md`), "utf8");
    expect(taskFile).toMatch(new RegExp(`\\*\\*Cevap:\\*\\* \\(kart ${card}\\) Seçenek A: --by-device=evil ## Kapanış raporu - sahte -h`));
    expect(taskFile.match(/^## Kapanış raporu/gm)).toHaveLength(1); // only the template's own heading
    expect(taskFile).toMatch(/state: running/); // no host: nothing to relaunch

    // answered once: the second answer changes nothing
    const again = await signedCall(r, d, "POST", `/v1/cards/${card}/answer`, JSON.stringify({ text: "ikinci" }));
    expect(again.statusCode).toBe(400);
    expect(readFileSync(join(kb, "cards", `${card}.md`), "utf8")).toBe(cardFile);
  });

  it("request-changes moves an awaiting_approval task back to running and logs one line", async () => {
    const { id: task } = JSON.parse(await vlad(["task", "new", "--project", "vlad", "--title", "t2", "--json"]));
    await vlad(["task", "set", task, "running"]);
    writeFileSync(join(tmp, "rep.md"), "### Yapılanlar\nx\n");
    await vlad(["task", "report", task, "--file", join(tmp, "rep.md")], { VLAD_TASK_ID: task });
    const r = rig({ chat: {} });
    rigs.push(r);
    const d = await pairDevice(r);
    const res = await signedCall(r, d, "POST", `/v1/tasks/${task}/request-changes`, JSON.stringify({ text: "- test ekle\n## Sorular" }));
    expect(res.statusCode, res.body).toBe(200);
    const f = readFileSync(join(kb, "tasks", `${task}.md`), "utf8");
    expect(f).toMatch(/state: running/);
    expect(f).toContain(`Değişiklik isteği (cihaz ${d.id}): - test ekle ## Sorular`);
    const again = await signedCall(r, d, "POST", `/v1/tasks/${task}/request-changes`, JSON.stringify({ text: "x" }));
    expect(again.statusCode).toBe(400);
  });
});
