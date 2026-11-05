// Pure file → test-bucket selection (no process spawning, so unit-bucket tests may import it). Map: test/scope.json.
// Rules, first hit wins per file: `all` → every bucket, `ignore` → no tests, `rules` → listed buckets, *.test.ts → run by path, anything else → every bucket (unmapped).

/** Glob subset: `**` crosses directories (also a trailing `/**`), `*` stays within a segment. */
export function matchGlob(path, glob) {
  const re = glob
    .split(/(\*\*\/|\*\*|\*)/)
    .map((t) => (t === "**/" ? "(?:.*/)?" : t === "**" ? ".*" : t === "*" ? "[^/]*" : t.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${re}$`).test(path);
}

const hit = (f, globs) => globs.some((g) => matchGlob(f, g));

/**
 * @param {string[]} files repo-relative posix paths of changed files
 * @param {{all: string[], ignore: string[], rules: {match: string[], buckets: string[]}[]}} scope
 * @param {Record<string, string[]>} buckets test/buckets.json (bucket names, canonical order = key order)
 * @returns {{buckets: string[], unit: "all"|"changed", files: string[], unmapped: string[], ignored: string[], all: boolean, warning?: string}}
 */
export function selectScope(files, scope, buckets) {
  const nonUnit = Object.keys(buckets).filter((b) => b !== "unit");
  const picked = new Set();
  const out = { buckets: [], unit: "changed", files: [], unmapped: [], ignored: [], all: false };
  if (files.length === 0) out.warning = "değişiklik yok: yalnız unit kovası (--changed) koşar";
  for (const f of files.map((x) => x.split("\\").join("/"))) {
    if (hit(f, scope.all)) out.all = true;
    else if (hit(f, scope.ignore)) out.ignored.push(f);
    else {
      const rule = scope.rules.find((r) => hit(f, r.match));
      if (rule) for (const b of rule.buckets) picked.add(b);
      else if (f.startsWith("test/") && f.endsWith(".test.ts")) out.files.push(f);
      else { out.unmapped.push(f); out.all = true; }
    }
  }
  if (out.all) {
    out.unit = "all";
    out.files = [];
    out.buckets = nonUnit;
  } else out.buckets = nonUnit.filter((b) => picked.has(b));
  return out;
}
