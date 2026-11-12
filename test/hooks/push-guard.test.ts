import { describe, expect, it } from "vitest";
import { checkWorkerPush } from "../../src/hooks/push-guard.js";

const ID = "T20261112-10";

describe("F-vlad-324: çalışan git push argv doğrulaması", () => {
  it("geçer: yalnız kendi dalı, tek ref", () => {
    for (const cmd of [`git push origin vlad/${ID}`, `git push -u origin vlad/${ID}`, `git push --set-upstream origin vlad/${ID}`, `cd x && git push origin vlad/${ID}`, `git push origin vlad/${ID} 2>&1 | tail -3`])
      expect(checkWorkerPush(cmd, ID), cmd).toBeNull();
  });
  it("reddedilir: + refspec, çoklu ref, refspec (:), tehlikeli bayraklar, başka dal", () => {
    for (const cmd of [
      `git push origin vlad/${ID} +main`, `git push origin +vlad/${ID}`, `git push origin vlad/${ID} main`, `git push -u origin vlad/${ID} main`,
      `git push origin vlad/${ID}:main`, `git push origin HEAD:vlad/${ID}`, `git push origin :vlad/${ID}`, `git push origin HEAD:main`,
      `git push -uvf origin vlad/${ID}`, `git push -fu origin vlad/${ID}`, `git push --no-verify origin vlad/${ID}`, `git push origin vlad/${ID} --no-verify`,
      `git push --mirror origin`, `git push origin --mirror`, `git push --prune origin vlad/${ID}`, `git push -o x=y origin vlad/${ID}`,
      `git push --force-with-lease origin vlad/${ID}`, `git push --delete origin vlad/${ID}`, `git push origin vlad/T20261112-99`, `git push origin main`, `git push`, `git push origin`,
      `git push upstream vlad/${ID}`, `git push --all origin`, `git push --tags origin`, `git push origin vlad/${ID} && git push origin main`, `git push origin vlad/${ID}; git push -f origin main`,
      "git push origin $(echo main)", `git push origin 'vlad/${ID}' main`,
    ]) expect(checkWorkerPush(cmd, ID), cmd).not.toBeNull();
  });
  it("madde 2: git global seçenekleri (-c/-C/--config-env/--git-dir/--work-tree/--exec-path) ile push reddedilir", () => {
    for (const o of ["-c remote.origin.pushurl=/x", "-c core.hooksPath=/x", "-c push.followTags=true", "-c url.x.insteadOf=y", "-C /w", "--config-env=a=B", "--git-dir=/g", "--work-tree=/w", "--exec-path=/e", "-c core.sshCommand=x"])
      expect(checkWorkerPush(`git ${o} push origin vlad/${ID}`, ID), o).not.toBeNull();
  });
  it("madde 4: sarmalayıcı/ayraç biçimleri (timeout, nohup, env, time, &, subshell, if) reddedilir", () => {
    for (const cmd of [`timeout 30 git push origin vlad/${ID}:main`, `timeout 30 git push origin vlad/${ID}`, `nohup git push origin vlad/${ID}:main`, `env -i git push origin main`, `time git push origin main`,
      `true & git push origin main`, `(git push origin main)`, `if true; then git push origin main; fi`, `{ git push origin main; }`, `FOO=1 git push origin main`, `command git push origin main`, `/usr/bin/git push origin main`,
      `bash -c 'git push origin main'`, `echo $(git push -f origin main)`, `git -c alias.p=push p origin +main`])
      expect(checkWorkerPush(cmd, ID), cmd).not.toBeNull();
  });
  it("madde 5: tırnak-bilinçli — alıntıdaki 'git push' serbest, tırnaklı 'push' tanınır", () => {
    for (const cmd of [`git commit -m "fix; git push guard"`, `git commit -m 'a && git push origin main'`, `git log --grep='git push'`, "git status", "git pull origin main", "npm test"])
      expect(checkWorkerPush(cmd, ID), cmd).toBeNull();
    for (const cmd of [`git 'push' origin main`, `git "push" origin vlad/${ID}:main`, `"git" push origin +main`, `git p\\ush origin main`])
      expect(checkWorkerPush(cmd, ID), cmd).not.toBeNull();
  });
  it("3. tur P1: satır devamı (backslash-newline, CRLF) birleştirilir; P2: alias yalnız yazılırken; bash -lc", () => {
    for (const cmd of ["git \\\npush --force origin main", "git \\\r\npush origin main", "git push \\\n--force origin vlad/T20261112-10", "git push origin \\\nmain", `git push origin vlad/${ID}:\\\nmain`, "git pu\\\nsh origin main"])
      expect(checkWorkerPush(cmd, ID), JSON.stringify(cmd)).not.toBeNull();
    expect(checkWorkerPush(`git push \\\n origin vlad/${ID}`, ID)).toBeNull();
    for (const cmd of [`git commit -m "fix alias.foo"`, "git log --grep=alias.foo", "git config --get alias.p", "git status"]) expect(checkWorkerPush(cmd, ID), cmd).toBeNull();
    for (const cmd of ["git -c alias.p=push p origin +main", "git --config-env=alias.p=X push origin main", "git config alias.p push", "git config --global alias.p 'push -f'"]) expect(checkWorkerPush(cmd, ID), cmd).not.toBeNull();
    for (const cmd of ["bash -lc 'git push origin main'", "sh -ec 'git push -f origin main'", "zsh -c 'git push origin main'"]) expect(checkWorkerPush(cmd, ID), cmd).not.toBeNull();
  });
  it("kimlik bilinmiyorsa yalnız vlad/T… biçimi aranır", () => {
    expect(checkWorkerPush("git push origin vlad/T20261112-10", null)).toBeNull();
    expect(checkWorkerPush("git push origin vlad/main", null)).not.toBeNull();
  });
});
