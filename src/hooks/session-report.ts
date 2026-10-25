// Thin SessionEnd hook entry: must exit 0 no matter what (even if the implementation fails to load).
process.exitCode = 0;

async function logFailure(err: unknown): Promise<void> {
  try {
    const { appendFileSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const home = process.env.VLAD_HOME ?? join(import.meta.dirname, "..", "..");
    let dir = join(home, "kb", "logs");
    try {
      dir = (await import("../kb/home.js")).kbPaths(home).logs;
    } catch {
      /* kb checkout missing: log next to the VLAD home instead of losing the failure */
    }
    mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    appendFileSync(join(dir, `hook-${now.slice(0, 10)}.log`), `${now} ${msg.replace(/\r?\n/g, " | ")}\n`, "utf8");
  } catch {
    /* nothing left to do */
  }
}

function swallow(err: unknown): void {
  process.exitCode = 0;
  void logFailure(err);
}

process.on("uncaughtException", swallow);
process.on("unhandledRejection", swallow);

try {
  const { realpathSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const same = (a: string, b: string) => realpathSync(a).toLowerCase() === realpathSync(b).toLowerCase();
  if (process.argv[1] && same(fileURLToPath(import.meta.url), process.argv[1])) {
    const { main } = await import("./report.js");
    await main();
  }
} catch (err) {
  swallow(err);
}
process.exitCode = 0;
