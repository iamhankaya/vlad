// Ortam parçaları (T20261110-05): tools, agent, launcher, mac-main, memory. check salt okuma; apply yalnız açık onayla çalıştırır / talimat basar.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { agentKeygen } from "../agent/start.js";
import { loadConfig } from "../kb/config.js";
import { readLocal, writeLocal } from "../fleet/state.js";
import { compose, result, run, upToDate, versionAtLeast } from "./io.js";
import type { ApplyAction, ItemCheck, PartCheck, Requirement, SetupContext, SetupPart } from "./types.js";

const item = (id: string, status: ItemCheck["status"], evidence: string, fix?: string): ItemCheck => ({ id, status, evidence, ...(fix ? { fix } : {}) });
type Entry = { required: Requirement; item: ItemCheck };

function cmdVersion(id: string, cmd: string, args: string[], min: string | undefined, required: Requirement, fix: string): Entry {
  const r = run(cmd, args);
  if (!r.ok) return { required, item: item(id, "eksik", `${cmd} bulunamadı`, fix) };
  const out = (r.stdout || r.stderr).trim().split("\n")[0] ?? "";
  if (min && !versionAtLeast(out, min)) return { required, item: item(id, "eski", `${cmd} ${out} < ${min}`, fix) };
  return { required, item: item(id, "ok", `${cmd} ${out}`.trim()) };
}

export const toolsPart: SetupPart = {
  id: "tools",
  async check() {
    const node = versionAtLeast(process.version, "22");
    const entries: Entry[] = [
      { required: "zorunlu", item: node ? item("tools:node", "ok", `node ${process.version}`) : item("tools:node", "eski", `node ${process.version} < 22`, "Node 22+ kur") },
      cmdVersion("tools:git", "git", ["--version"], "2.38", "zorunlu", "git 2.38+ kur"),
    ];
    const help = run("claude", ["--help"]);
    entries.push({ required: "zorunlu", item: !help.ok && !help.stdout ? item("tools:claude", "eksik", "claude CLI bulunamadı", "Claude Code kur") : /--autocompact/.test(help.stdout + help.stderr) ? item("tools:claude", "ok", "claude CLI (--autocompact destekli)") : item("tools:claude", "eski", "claude CLI --autocompact bayrağını tanımıyor", "claude'u güncelle") });
    const gh = run("gh", ["auth", "status"]);
    entries.push({ required: "bilgi", item: gh.ok ? item("tools:gh", "ok", "gh giriş yapılmış") : item("tools:gh", "eksik", "gh yok ya da giriş yapılmamış (yalnız pr/CI/GitHub kb)", "gh auth login") });
    const codex = run("codex", ["--version"]);
    entries.push({ required: "bilgi", item: codex.ok ? item("tools:codex", "ok", `codex ${codex.stdout.trim()}`) : item("tools:codex", "eksik", "codex yok (3. göz; Fable yedeği)", "isteğe bağlı") });
    return compose("tools", entries);
  },
  async apply(c) {
    const k = await this.check(c);
    return k.status === "ok" ? upToDate("tools") : result("tools", (k.items ?? []).filter((i) => i.status !== "ok").map((i) => ({ kind: "print" as const, what: `${i.evidence}${i.fix ? ` → ${i.fix}` : ""}` })));
  },
};

const brainPeers = (c: SetupContext): string[] => { const cfg = loadConfig(c.vladHome); return (cfg.machines ?? []).map((m) => m.name); };
export const agentPart: SetupPart = {
  id: "agent",
  async check(c) {
    let cfg;
    try { cfg = loadConfig(c.vladHome); } catch (e) { return { part: "agent", status: "n/a", severity: "info", evidence: `config okunamadı: ${(e as Error).message}` }; }
    if (!cfg.machines) return { part: "agent", status: "n/a", severity: "info", evidence: "tek makine: Agent gerekmez" };
    const local = readLocal();
    const self = process.env.VLAD_MACHINE || local.self;
    if (!self) return compose("agent", [{ required: "zorunlu", item: item("agent:self", "eksik", "makine kimliği yok (vlad.local.json self)", "vlad setup --only agent") }]);
    const need = self === cfg.brain ? [self, ...cfg.machines.map((m) => m.name).filter((n) => n !== self)] : [self, cfg.brain!];
    return compose("agent", need.map((n) => ({ required: "zorunlu" as const, item: item(`agent:key:${n}`, local.keys[n] ? "ok" : "eksik", local.keys[n] ? `${n} anahtarı var` : `${n} anahtarı yok`, n === self ? `vlad agent keygen ${n}` : self === cfg.brain ? `vlad agent keygen ${n}` : `vlad setup --join ${n}`) })));
  },
  async apply(c) {
    const cfg = loadConfig(c.vladHome);
    if (!cfg.machines || c.answers.machines !== "multi") return result("agent", [{ kind: "skip", what: "tek makine: Agent kurulmaz" }], [], "tek makine");
    const acts: ApplyAction[] = [];
    const name = c.answers.machine?.name!;
    if (!c.dryRun && readLocal().self !== name) { const l = readLocal(); writeLocal({ ...l, self: name }); acts.push({ kind: "write", what: `vlad.local.json self=${name}` }); }
    if (c.answers.keys === "generate" && c.answers.role === "brain") {
      if (!c.confirmed.has("keygen")) acts.push({ kind: "skip", what: "anahtar üretimi açık onay ister (confirm: keygen)" });
      else for (const n of brainPeers(c)) {
        if (readLocal().keys[n]) continue;
        acts.push({ kind: "write", what: `anahtar üretildi: ${n} (değer basılmaz)` });
        if (!c.dryRun) agentKeygen(n, false);
      }
    }
    if (c.answers.agentboot) {
      if (!c.confirmed.has("agent-install")) acts.push({ kind: "skip", what: "Agent oto-başlatma açık onay ister (confirm: agent-install)" });
      else {
        acts.push({ kind: "run", what: "vlad agent install --apply" });
        if (!c.dryRun) { const r = run(process.execPath, [join(c.vladHome, "dist", "cli.js"), "agent", "install", "--apply"], { timeoutMs: 60_000 }); if (!r.ok) throw new Error(`agent install başarısız: ${r.stderr.trim()}`); }
      }
    }
    return acts.some((a) => a.kind === "write" || a.kind === "run") ? result("agent", acts) : acts.length ? result("agent", acts) : upToDate("agent");
  },
};

export const launcherPart: SetupPart = {
  id: "launcher",
  async check(c) {
    let mode = "auto";
    try { mode = loadConfig(c.vladHome).launcher ?? "auto"; } catch { /* config parçası bildirir */ }
    if (mode === "terminal" || mode === "cloud") return { part: "launcher", status: "n/a", severity: "info", evidence: `launcher=${mode}` };
    if (c.platform === "win32") {
      const ps = run("powershell.exe", ["-NoProfile", "-Command", "exit 0"]);
      return compose("launcher", [{ required: "zorunlu", item: ps.ok ? item("launcher:windows-terminal", "ok", "powershell.exe var") : item("launcher:windows-terminal", "eksik", "powershell.exe yok", "Windows PowerShell 5.1+") }]);
    }
    return compose("launcher", [cmdVersion("launcher:tmux", "tmux", ["-V"], undefined, "zorunlu", c.platform === "darwin" ? "brew install tmux" : "tmux kur")]);
  },
  async apply(c) {
    const k = await this.check(c);
    return k.status === "ok" || k.status === "n/a" ? upToDate("launcher") : result("launcher", [{ kind: "print", what: `${k.evidence} → ${k.fix}` }]);
  },
};

const plist = (c: SetupContext) => join(c.home, "Library", "LaunchAgents", "com.vlad.main.plist");
export const macMainPart: SetupPart = {
  id: "mac-main",
  async check(c) {
    if (c.platform !== "darwin") return { part: "mac-main", status: "n/a", severity: "info", evidence: "yalnız macOS" };
    return compose("mac-main", [{ required: "bilgi", item: existsSync(plist(c)) ? item("mac-main:launchagent", "ok", "com.vlad.main LaunchAgent var") : item("mac-main:launchagent", "eksik", "ana oturum LaunchAgent'ı yok (isteğe bağlı)", "scripts/mac/setup.sh --apply") }]);
  },
  async apply(c) {
    if (c.platform !== "darwin" || !c.answers.mainsession) return result("mac-main", [{ kind: "skip", what: "seçilmedi / macOS değil" }], [], "seçilmedi");
    if (existsSync(plist(c))) return upToDate("mac-main");
    if (!c.confirmed.has("mac-main-install")) return result("mac-main", [{ kind: "skip", what: "LaunchAgent kurulumu açık onay ister (confirm: mac-main-install)" }], [], "onay yok");
    if (!c.dryRun) { const r = run("bash", [join(c.vladHome, "scripts", "mac", "setup.sh"), "--apply"], { timeoutMs: 60_000 }); if (!r.ok) throw new Error(`mac setup başarısız: ${r.stderr.trim()}`); }
    return result("mac-main", [{ kind: "run", what: "scripts/mac/setup.sh --apply" }]);
  },
};

export const memoryPart: SetupPart = {
  id: "memory",
  async check(c) {
    const dir = join(c.claudeDir, "projects", c.vladHome.replace(/[^A-Za-z0-9]/g, "-"), "memory");
    return { part: "memory", status: existsSync(dir) ? "ok" : "n/a", severity: "info", evidence: existsSync(dir) ? "hafıza dizini var" : "hafıza dizini yok (Claude oluşturur; bilgi)" };
  },
  async apply() { return upToDate("memory"); },
};
