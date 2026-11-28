import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkWorkerMode } from "../../src/hooks/mode-guard.js";
import { setSecretDirForTests } from "../../src/mode/token.js";

// T20261128-04 (F-vlad-410..413): korunan köklere giden jokerli/yönlendirmeli/ata hedefli yazmalar fail-closed. Yalnız geçici dizin; gerçek dizinlere yazılmaz (kanca saf).
let root: string, vh: string, kb: string, cwd: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "vlad-fc-")));
  vh = join(root, "vh"); kb = join(root, "kb"); cwd = join(root, "wt");
  mkdirSync(join(vh, "dist", "hooks"), { recursive: true }); mkdirSync(join(cwd, "src"), { recursive: true }); mkdirSync(kb);
  writeFileSync(join(kb, "mode.json"), "{}");
  setSecretDirForTests(join(root, ".vlad-secret"));
});
afterEach(() => setSecretDirForTests(null));
const b = (command: string, at = cwd) => checkWorkerMode("Bash", { command }, kb, { vladHome: vh, cwd: at });

describe("F-vlad-410: çoklu POSIX sınıfı / collating / eşdeğerlik köşeli parantezi", () => {
  it("reddedilir", () => {
    for (const c of ["echo x > ~/.claude/settings.js[[:alpha:][:digit:]]n", `tee ${vh}/vlad.config.js[[:alpha:][:digit:]]n`, `tee ${vh}/dist/hook[[:alpha:][:digit:]]/push-guard`,
      "bash -c 'tee ~/.claude/settings.js[[.o.]]n'", "echo x > ~/.claude/settings.js[[=o=]]n", `cp x ${vh}/vlad.config.local.js[a[:alpha:]]n`, `tee ${kb}/mode.js[[.o.][:alpha:]]n`])
      expect(b(c), c).not.toBeNull();
    expect(checkWorkerMode("Write", { file_path: "~/.claude/settings.js[[:alpha:][:digit:]]n" }, kb, { vladHome: vh, cwd })).not.toBeNull();
  });
  it("ilgisiz köşeli parantez serbest", () => {
    for (const c of ["echo x > out-[[:digit:]].txt", "tee src/[[:alpha:][:digit:]]x.ts", "cp x src/[a-c].ts"]) expect(b(c), c).toBeNull();
  });
});

describe("F-vlad-411: zsh (a|b) alternasyonu", () => {
  it("reddedilir", () => {
    for (const c of ["echo x > ~/.cl(a|x)ude/settings.json", "tee ~/.claude/settings.(json|x)", `tee ${vh}/vlad.config.(json|x)`, `tee ${vh}/dist/(hooks|x)/push-guard`, "tee ~/.claude/settings.(json)",
      `tee ${kb}/mode.(json|x)`, "bash -c 'echo x > ~/.cl(a|x)ude/settings.json'", `cp x ${vh}/(dist|x)/hooks/a.js`])
      expect(b(c), c).not.toBeNull();
  });
  it("normal alt kabuk / komut ikamesi / ilgisiz grup serbest", () => {
    for (const c of ["(cd src && ls)", "echo $(date) > out.txt", "echo $(a|b) > out.txt", "tee src/(a|b).ts", "ls | wc -l > n.txt", "f() { :; }; tee out.txt"]) expect(b(c), c).toBeNull();
  });
});

describe("F-vlad-412: >| noclobber yönlendirmesi", () => {
  it("reddedilir", () => {
    for (const c of ["echo x >| ~/.claude/settings.json", `echo x >| ${vh}/vlad.config.json`, `echo x >|${kb}/mode.json`, `echo x 1>| ${vh}/dist/hooks/a.js`, `echo x >| ${vh}/vlad.config.js?n`])
      expect(b(c), c).not.toBeNull();
  });
  it("serbest: kendi dosyası, boru, /dev/null", () => {
    for (const c of ["echo x >| out.txt", "echo x | tee out.txt", "echo x >| /dev/null", "cat ~/.claude/settings.json | wc -l"]) expect(b(c), c).toBeNull();
  });
});

describe("F-vlad-413: korunan köke/atasına silme-taşıma-dizin hedefli kopyalama", () => {
  it("reddedilir", () => {
    for (const c of [`rm -rf ${vh}/dist`, `rm -rf ${vh}/di*`, `cp -r hooks ${vh}/di?t`, "cp settings.json ~/.claude/", "cp -t ~/.claude settings.json", "rm -rf ~/.claude", "mv ~/.cla* ~/old", `rm -rf ${kb}`,
      `rm -rf ${vh}`, "rm -rf ~", `mv ${vh}/dist ${vh}/x`, `mv ${vh}/dist/hooks /tmp/x`, `rm -rf ${root}`, `cp -r x ${kb}`, `cp -r x ${vh}/dist/hooks`, `rm -rf ${root}/.vlad-secret`, `rm -rf ${root}/.vlad-*`, "rm -r ~/.cl{a,x}ude", `install -t ${vh}/dist/hooks x`, "rsync -a x/ ~/.claude/"])
      expect(b(c), c).not.toBeNull();
  });
  it("serbest: kendi dizinleri, okuma, korunan olmayan hedefler", () => {
    for (const c of ["rm -rf build", `rm -rf ${cwd}/dist`, "rm -rf node_modules", "cp -r a b", "cp x src/", "mv a b", `rm -rf ${cwd}/*`, `cp x ${vh}/src`, `rm -f ${vh}/src/a.ts`, "ls ~/.claude", "cat ~/.claude/settings.json", `cp ${vh}/dist/x.js out.js`, "cp x ~/.claude/../out.txt"]) expect(b(c), c).toBeNull();
  });
});

describe("bilgi maddesi: cd <korunan kök> sonrası göreli yazma", () => {
  it("reddedilir", () => {
    for (const c of ["cd ~/.claude && echo x > settings.json", `cd ${vh} && echo x > vlad.config.json`, `cd ${vh}/dist/hooks && cp x push-guard-hook.js`, "pushd ~/.claude; tee settings.local.json", `cd ${kb}; echo x > mode.json`, `cd ${vh} && cd dist && tee hooks/a.js`, "cd ~/.claude && tee settings.js*"])
      expect(b(c), c).not.toBeNull();
  });
  it("serbest: korunmayan dizine cd, korunan dizinde okuma", () => {
    for (const c of ["cd src && echo x > a.json", `cd ${vh} && cat vlad.config.json`, `cd ${vh}/src && tee a.ts`, "cd ~/.claude && ls", `cd ${cwd} && echo x > out.txt`]) expect(b(c), c).toBeNull();
  });
});

describe("review turu: cd çözümleyici, grup/nokta, doğrusal tarama, tar/unzip", () => {
  it("cd yönlendirmeli / öneklı / bloklu / çözülemeyen hedefli göreli yazma reddedilir", () => {
    for (const c of ["cd ~/.claude 2>&1 && tee settings.json", "cd ~/.claude >/dev/null && tee settings.json", "{ cd ~/.claude; tee settings.json; }", "builtin cd ~/.claude && tee settings.json", "command cd ~/.claude && tee settings.json",
      "if true; then cd ~/.claude; echo x > settings.json; fi", "bash -c 'cd ~/.claude 2>/dev/null && echo x > settings.json'", `cd ${vh}/dist/hooks 2>&1 && echo x > a.js`,
      "cd $SOMEWHERE && tee settings.json", "cd - && tee settings.local.json", `cd "$X"/y && echo x > vlad.config.json`])
      expect(b(c), c).not.toBeNull();
    for (const c of ["cd $SOMEWHERE && tee out.txt", "cd src 2>&1 && tee a.json", "cd $X && make > log.txt"]) expect(b(c), c).toBeNull();
  });
  it("grup: noktalı ad ve içinde / olan alternatif", () => {
    for (const c of ["tee ~/(.claude|x)/settings.json", "tee ~/(.claude)/settings.json", "tee ~/(.claude/settings.json|x)", `tee ${vh}/(dist/hooks|x)/a.js`]) expect(b(c), c).not.toBeNull();
  });
  it("kapanmayan [ / [: yığını doğrusal sürede biter", () => {
    const t0 = Date.now();
    for (const c of [`tee ${"[[:".repeat(8000)}`, `tee ${"[x".repeat(20000)}`, `tee ${"[.".repeat(10000)}`]) b(c);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
  it("tar/unzip hedefi korunan dizin", () => {
    for (const c of ["tar -xf x.tar -C ~/.claude", "unzip x.zip -d ~/.claude", `tar -xf x.tar -C ${vh}/dist/hooks`]) expect(b(c), c).not.toBeNull();
    expect(b("tar -xf x.tar -C out")).toBeNull();
  });
});

describe("yanlış pozitif listesi (çalışanın kendi worktree'si)", () => {
  it("izinli", () => {
    for (const c of ["echo x > *.json", "cp x src/*", "tee out-?.txt", "echo x > {a,b}.ts", "echo '*.json' > notes.txt", "cat ~/.claude/settings.json", "ls ~/.claude", "grep -r x ~/.claude/projects", "rm src/a.ts", "echo x > src/a.json"]) expect(b(c), c).toBeNull();
  });
});
