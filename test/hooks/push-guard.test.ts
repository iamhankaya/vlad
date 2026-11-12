import { describe, expect, it } from "vitest";
import { checkWorkerPush } from "../../src/hooks/push-guard.js";

const ID = "T20261112-10";
const sha = "a".repeat(40);

describe("F-vlad-324: çalışan git push argv doğrulaması", () => {
  it("geçer: yalnız kendi dalı, tek ref", () => {
    for (const cmd of [
      `git push origin vlad/${ID}`, `git push -u origin vlad/${ID}`, `git push --set-upstream origin vlad/${ID}`,
      `git push origin HEAD:vlad/${ID}`, `git push -u origin HEAD:vlad/${ID}`, `git push origin HEAD:refs/heads/vlad/${ID}`,
      `git push origin ${sha}:refs/heads/vlad/${ID}`, `git push origin ${sha.slice(0, 12)}:vlad/${ID}`,
    ]) expect(checkWorkerPush(cmd, ID), cmd).toBeNull();
  });
  it("reddedilir: + refspec, çoklu ref, tehlikeli bayraklar, başka dal", () => {
    for (const cmd of [
      `git push origin vlad/${ID} +main`, `git push origin +vlad/${ID}`, `git push origin vlad/${ID} main`, `git push -u origin vlad/${ID} main`,
      `git push -uvf origin vlad/${ID}`, `git push -fu origin vlad/${ID}`, `git push --no-verify origin vlad/${ID}`, `git push origin vlad/${ID} --no-verify`,
      `git push --mirror origin`, `git push origin --mirror`, `git push --prune origin vlad/${ID}`, `git push -o x=y origin vlad/${ID}`,
      `git push --force-with-lease origin vlad/${ID}`, `git push --delete origin vlad/${ID}`, `git push origin :vlad/${ID}`, `git push origin HEAD:main`,
      `git push origin HEAD:vlad/T20261112-99`, `git push origin vlad/T20261112-99`, `git push origin main`, `git push`, `git push origin`,
      `git push upstream vlad/${ID}`, `git push origin HEAD:vlad/${ID}:main`, `git push origin refs/heads/*:refs/heads/*`, `git push --all origin`, `git push --tags origin`,
      `git push origin vlad/${ID} && git push origin main`, `git push origin vlad/${ID}; git push -f origin main`, "git push origin $(echo main)",
      `git -C /x push origin main`, `git push origin 'vlad/${ID}' main`,
    ]) expect(checkWorkerPush(cmd, ID), cmd).not.toBeNull();
  });
  it("yanlış pozitif yok: push'u anan başka komutlar, zincirde/yönlendirmede kendi push'u geçer; zincirli kötü push reddedilir", () => {
    for (const cmd of [`git commit -m "docs: git push guard"`, `git log --grep='git push'`, `cd x && git push origin vlad/${ID}`, `git push origin vlad/${ID} 2>&1`, `git push origin vlad/${ID} 2>&1 | tail -3`, `git -C /w push origin vlad/${ID}`]) expect(checkWorkerPush(cmd, ID), cmd).toBeNull();
    for (const cmd of [`cd x && git push origin main`, `echo $(git push -f origin main)`, `FOO=1 git push origin main`, `command git push origin main`, `/usr/bin/git push origin main`, `git -c alias.p=push p origin +main`, `"git" push origin +main`, `sh -c 'git push origin main'`]) expect(checkWorkerPush(cmd, ID), cmd).not.toBeNull();
  });
  it("push olmayan komutlara dokunmaz", () => {
    for (const cmd of ["git status", "git pull origin main", "npm test", "git log --oneline"]) expect(checkWorkerPush(cmd, ID), cmd).toBeNull();
  });
  it("kimlik bilinmiyorsa yalnız vlad/T… biçimi aranır", () => {
    expect(checkWorkerPush("git push origin vlad/T20261112-10", null)).toBeNull();
    expect(checkWorkerPush("git push origin vlad/main", null)).not.toBeNull();
  });
});
