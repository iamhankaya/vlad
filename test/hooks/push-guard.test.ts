import { describe, expect, it } from "vitest";
import { checkWorkerPush } from "../../src/hooks/push-guard.js";

const ID = "T20261112-10";

describe("F-vlad-324: çalışan git push — katı tam-komut kalıbı", () => {
  it("geçer: yalnız kalıp (isteğe bağlı cd öneki, -u, 2>&1)", () => {
    for (const cmd of [`git push origin vlad/${ID}`, `git push -u origin vlad/${ID}`, `git push --set-upstream origin vlad/${ID}`, `git push origin vlad/${ID} 2>&1`,
      `cd /Users/x/dev/vlad-wt/${ID} && git push origin vlad/${ID}`, `  git push -u origin vlad/${ID}  `, `git push origin \\\nvlad/${ID}`])
      expect(checkWorkerPush(cmd, ID), cmd).toBeNull();
  });
  it("reddedilir: bypass örnekleri (+, ref, refspec, bayrak, global seçenek, sarmalayıcı, zincir, alt kabuk, tırnak, satır devamı, alias)", () => {
    for (const cmd of [
      `git push origin vlad/${ID} +main`, `git push origin +vlad/${ID}`, `git push origin vlad/${ID} main`, `git push -u origin vlad/${ID} main`, `git push origin vlad/${ID}:main`, `git push origin HEAD:vlad/${ID}`,
      `git push origin :vlad/${ID}`, `git push -uvf origin vlad/${ID}`, `git push -fu origin vlad/${ID}`, `git push --no-verify origin vlad/${ID}`, `git push origin vlad/${ID} --no-verify`,
      `git push --mirror origin`, `git push --prune origin vlad/${ID}`, `git push -o x=y origin vlad/${ID}`, `git push --force-with-lease origin vlad/${ID}`, `git push --delete origin vlad/${ID}`,
      `git push origin vlad/T20261112-99`, `git push origin main`, `git push`, `git push upstream vlad/${ID}`, `git push --all origin`, `git push --tags origin`,
      `git push origin vlad/${ID} && git push origin main`, `git push origin vlad/${ID}; git push -f origin main`, `git push origin vlad/${ID} | tail -3`, `git push origin vlad/${ID} > /tmp/x`,
      "git push origin $(echo main)", `git push origin 'vlad/${ID}'`, `git push origin vlad/${ID}$X`,
      `git -c remote.origin.pushurl=/x push origin vlad/${ID}`, `git -c core.hooksPath=/x push origin vlad/${ID}`, `git -C /w push origin vlad/${ID}`, `git --git-dir=/g push origin vlad/${ID}`,
      `git >/dev/null push origin main`, `timeout 30 git push origin vlad/${ID}:main`, `timeout 30 git push origin vlad/${ID}`, `nohup git push origin vlad/${ID}`, `env -i git push origin main`, `time git push origin main`,
      `true & git push origin main`, `(git push origin main)`, `if true; then git push origin main; fi`, `{ git push origin main; }`, `FOO=1 git push origin main`, `command git push origin main`, `/usr/bin/git push origin main`,
      `bash -lc 'git push origin main'`, `sh -ec 'git push -f origin main'`, `echo $(git push -f origin main)`, `git -c alias.p=push p origin +main`, "git config alias.p push",
      `git 'push' origin main`, `git "push" origin vlad/${ID}:main`, `"git" push origin +main`, `git p\\ush origin main`,
      "git \\\npush --force origin main", "git \\\r\npush origin main", "git push \\\n--force origin vlad/T20261112-10", `cd x && git push origin vlad/${ID}:main`, `cd x; git push origin vlad/${ID}`,
      `git push origin vlad/${ID}\ngit push -f origin main`,
    ]) expect(checkWorkerPush(cmd, ID), JSON.stringify(cmd)).not.toBeNull();
  });
  it("push anmayan komutlara dokunmaz; git+push birlikte geçen commit mesajı bilinen yanlış pozitif", () => {
    for (const cmd of ["git status", "git pull origin main", "npm test", "git log --oneline", `git commit -m "fix alias.foo"`, "git config --get alias.p", `git commit -F /tmp/msg`, `echo push`])
      expect(checkWorkerPush(cmd, ID), cmd).toBeNull();
    for (const cmd of [`git commit -m "fix; git push guard"`, `git log --grep='git push'`]) expect(checkWorkerPush(cmd, ID), cmd).not.toBeNull();
  });
  it("kimlik bilinmiyorsa yalnız vlad/T… biçimi aranır", () => {
    expect(checkWorkerPush("git push origin vlad/T20261112-10", null)).toBeNull();
    expect(checkWorkerPush("git push origin vlad/main", null)).not.toBeNull();
  });
});
