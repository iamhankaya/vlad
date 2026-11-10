import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { getVladHome } from "../../kb/index.js";
import { readInput } from "../../kb/input.js";
import { CONFIRM_ACTIONS, SETUP_EXIT, validateAnswers, type ConfirmAction, type SetupAnswers } from "../../setup/index.js";
import { interviewAnswers } from "../../setup/interactive.js";
import { buildContext, parseOnly, runAddWorker, runCheck, runJoin, runSetup, runUninstall, runUpgrade } from "../../setup/run.js";
import type { Kit } from "../kit.js";
import type { Opts } from "../ctx.js";

const OSES = ["win32", "darwin", "linux"] as const;

export function registerSetup(program: Command, k: Kit): void {
  const { ctx, out, def } = k;
  const usage = (msg: string, details: string[] = []): never => {
    ctx.stderr.write(ctx.argv.includes("--json") ? JSON.stringify({ error: msg, details }) + "\n" : [`hata: ${msg}`, ...details.map((d) => `  ${d}`)].join("\n") + "\n");
    return ctx.exit(SETUP_EXIT.usage);
  };
  /** `--answers`: satır içi JSON, `-` (stdin) ya da dosya yolu. */
  function readAnswers(spec: string): unknown {
    const text = spec.trim().startsWith("{") ? spec : spec === "-" ? readInput("-") : readFileSync(spec, "utf8");
    let raw: unknown;
    try { raw = JSON.parse(text); } catch (e) { return usage(`--answers JSON değil: ${(e as Error).message}`); }
    if (typeof raw === "object" && raw !== null && "confirm" in raw) return usage("--answers içinde 'confirm' kabul edilmez: onayı --confirm <eylem,...> bayrağıyla ver (dosya sahibi dış eylem onayı veremez)");
    return raw;
  }

  def(program, "setup", "Kurulum sihirbazı: yeni makine/arkadaş kurulumu; --check doktor, --upgrade eşitleme, --join/--add-worker çok makine", async (o: Opts) => {
    // VLAD_SETUP_PLATFORM yalnız test ortamında (VLAD_TEST=1 ya da NODE_ENV=test) geçerli; üretimde gerçek platform kullanılır.
    const testEnv = process.env.VLAD_TEST === "1" || process.env.NODE_ENV === "test";
    const platform = (testEnv && process.env.VLAD_SETUP_PLATFORM && ["win32", "darwin", "linux"].includes(process.env.VLAD_SETUP_PLATFORM) ? process.env.VLAD_SETUP_PLATFORM : process.platform) as "win32" | "darwin" | "linux";
    // Dış etkili eylem onayı yalnız --confirm bayrağıyla ya da TTY sorusuyla; cevap dosyasındaki confirm reddedilir (dosya sahibi onay veremez).
    const confirmFlag = o.confirm ? String(o.confirm).split(",").map((s) => s.trim()).filter(Boolean) : [];
    const badConfirm = confirmFlag.filter((x) => !(CONFIRM_ACTIONS as readonly string[]).includes(x));
    if (badConfirm.length) return usage(`--confirm yalnız şunlar: ${CONFIRM_ACTIONS.join("|")}`);
    const modes = ["check", "upgrade", "uninstall", "join", "addWorker"].filter((m) => o[m] !== undefined && o[m] !== false);
    if (modes.length > 1) usage(`şu bayraklar birlikte kullanılamaz: ${modes.join(", ")}`);
    const only = parseOnly(o.only as string | undefined);
    const base = { vladHome: getVladHome(), env: ctx.env, dryRun: !!o.dryRun, yes: !!o.yes, platform };

    if (o.check) {
      const r = await runCheck(buildContext(base), { only, strict: !!o.strict });
      const lines = r.parts.map((p) => `${p.status === "ok" ? "✓" : p.status === "n/a" ? "-" : p.severity === "error" ? "✗" : "!"} ${p.part.padEnd(14)} ${p.status.padEnd(8)} ${p.evidence}${p.fix && p.status !== "ok" ? `\n    → ${p.fix}` : ""}`);
      if (r.experimental) lines.push(...r.experimental);
      lines.push(r.ok ? "sonuç: yeşil" : "sonuç: kırmızı (eksik/eski/çakışan var)");
      out(o, r, lines.join("\n"));
      process.exitCode = r.exit;
      return;
    }

    let answers: SetupAnswers = {};
    let wizard = false;
    const needsAnswers = !o.upgrade && !o.uninstall && !o.addWorker;
    if (needsAnswers) {
      let raw: unknown;
      if (o.answers) raw = readAnswers(o.answers as string);
      else if (process.stdin.isTTY && process.stdout.isTTY && !o.json) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try { raw = await interviewAnswers(async (p, d) => rl.question(d ? `${p} (${d}): ` : `${p}: `), platform); } finally { rl.close(); }
        wizard = true;
      } else return usage("etkileşimsiz ortamda --answers <json|-> gerekli", ["cevap anahtarları: vlad setup --help; örnek: {\"role\":\"brain\",\"machines\":\"single\",\"kb\":{\"mode\":\"local\"},\"roots\":[\"~/dev\"]}"]);
      if (raw !== undefined) {
        const v = validateAnswers(raw, { platform });
        if (!v.ok) {
          ctx.stderr.write(ctx.argv.includes("--json") ? JSON.stringify({ error: "geçersiz cevaplar", details: v.errors }) + "\n" : ["hata: geçersiz cevaplar", ...v.errors.map((e) => `  ${e}`)].join("\n") + "\n");
          return ctx.exit(v.errors.some((e) => e.startsWith("role:") && /linux/.test(e)) ? SETUP_EXIT.failed : SETUP_EXIT.usage);
        }
        answers = v.answers;
      }
      if (confirmFlag.length) answers = { ...answers, confirm: confirmFlag as ConfirmAction[] }; // wizard kendi confirm cevaplarını taşır; bayrak ekler
      else if (!wizard) answers = { ...answers, confirm: [] };
    }
    let aw: { machine?: { agent?: { host?: string; port?: number } }; keys?: string; confirm?: string[] } = {};
    if (o.addWorker && o.answers) { const raw = readAnswers(o.answers as string); if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return usage("--answers bir JSON nesnesi olmalı"); aw = raw as typeof aw; }
    if (o.addWorker) answers = { confirm: confirmFlag as ConfirmAction[] };
    const c = buildContext({ ...base, answers });
    const warn: string[] = [];

    let results;
    if (o.upgrade) results = await runUpgrade(c);
    else if (o.uninstall) { results = []; for (const id of parseOnly(o.uninstall as string)!) results.push(await runUninstall(c, id)); }
    else if (o.addWorker) {
      const nm = o.addWorker as string;
      const host = (o.host as string | undefined) ?? aw.machine?.agent?.host;
      const os = (o.os as string | undefined) ?? (/^win/i.test(nm) ? "win32" : /^(mac|darwin)/i.test(nm) ? "darwin" : /^linux/i.test(nm) ? "linux" : undefined);
      if (!host || !os) return usage("--add-worker için --host <özel IP> (ya da answers.machine.agent.host) ve --os darwin|win32|linux gerekli");
      if (!(OSES as readonly string[]).includes(os)) return usage("--os darwin|win32|linux olmalı");
      results = [await runAddWorker(c, nm, { os: os as any, host, port: o.port ? Number(o.port) : aw.machine?.agent?.port, keygen: aw.keys === "generate" })];
    } else if (o.join) {
      if (o.answers === "-") return usage("--join anahtarı stdin'den okur: --answers için dosya yolu ya da satır içi JSON ver ('-' olmaz)");
      const brainKey = process.stdin.isTTY ? undefined : readInput("-").trim() || undefined;
      results = await runJoin(c, { only, brain: o.join as string, brainHost: o.brainHost as string | undefined, brainPort: o.brainPort ? Number(o.brainPort) : undefined, brainOs: o.brainOs as any, brainKey });
    } else results = await runSetup(c, { only });

    const lines = results.flatMap((r) => [`${r.changed ? "●" : "○"} ${r.part}${r.skipped ? ` (atlandı: ${r.skipped})` : ""}`, ...r.actions.map((a) => `    ${a.kind}: ${a.what}`), ...r.backups.map((b) => `    yedek: ${b}`)]);
    out(o, { dryRun: !!o.dryRun, results }, [...warn, ...lines].join("\n"));
  })
    .option("--check", "salt okuma doktor (çıkış 0 yeşil, 1 hata, 2 kullanım)")
    .option("--strict", "--check: yalnız-uyarıları da hata say")
    .option("--answers <json|->", "cevap dosyası (satır içi JSON, dosya yolu ya da - stdin); sır içermez")
    .option("--dry-run", "hiçbir şeye dokunmadan yapılacakları göster")
    .option("--yes", "yalnız güvenli parçalarda onay sorma (repo oluşturma, anahtar, Agent/LaunchAgent, izinler için answers.confirm gerekir)")
    .option("--only <parça,...>", "yalnız bu parçalar")
    .option("--upgrade", "git pull sonrası eşitleme (build bilgisi, global skill'ler, hook)")
    .option("--uninstall <parça>", "yalnız VLAD'ın yazdığı girdileri geri al (hooks|global-skills|config)")
    .option("--join <beyin>", "ikinci makine: işçi kurulumu; beyinle paylaşılan anahtar stdin'den")
    .option("--brain-host <ip>", "--join: beyin config'te yoksa özel adresi")
    .option("--brain-port <n>", "--join: beyin Agent portu (7437)")
    .option("--brain-os <os>", "--join: beyin işletim sistemi")
    .option("--add-worker <ad>", "beyinde: işçi makineyi machines'e ekle (--host, --os)")
    .option("--host <ip>", "--add-worker: işçinin özel adresi")
    .option("--os <os>", "--add-worker: işçinin işletim sistemi")
    .option("--port <n>", "--add-worker: Agent portu (7437)")
    .option("--confirm <eylem,...>", "dış etkili eylem onayı (kb-repo-create|keygen|agent-install|mac-main-install|permissions-write|plugins-write); --yes ve --answers dosyası onay vermez");
}
