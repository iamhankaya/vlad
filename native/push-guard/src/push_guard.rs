//! src/hooks/push-guard.ts `checkWorkerPush` birebir.

use crate::text::{js_re, js_trim};
use regex::Regex;
use std::sync::OnceLock;

pub const NOT_PATTERN: &str = "çalışan push reddedildi: komut tam kalıba uymuyor (izinli: [cd <dizin> && ]git push [-u] origin vlad/<kendi-id> [2>&1]; commit mesajında git+push geçiyorsa `git commit -F <dosya>`)";
pub const NOT_OWN: &str = "çalışan push reddedildi: yalnız kendi vlad/<id> dalı";

fn re(cell: &'static OnceLock<Regex>, src: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(&js_re(src)).expect("statik regex"))
}

/// null = serbest, Some = ret nedeni.
pub fn check_worker_push(command: &str, own_id: Option<&str>) -> Option<&'static str> {
    static CONT: OnceLock<Regex> = OnceLock::new();
    static GIT: OnceLock<Regex> = OnceLock::new();
    static PUSH: OnceLock<Regex> = OnceLock::new();
    static ALLOWED: OnceLock<Regex> = OnceLock::new();
    let joined = re(&CONT, r"\\\r?\n").replace_all(command, ""); // satır devamı: bash birleştirir
    let c = js_trim(&joined);
    let bare: String = c.chars().filter(|ch| !matches!(ch, '"' | '\'' | '\\')).collect();
    // F-vlad-405: TS `/\bgit\b/i` (non-unicode /i yalnız ASCII katlar = `(?i-u:…)`)
    if !re(&GIT, "⟨b⟩(?i-u:git)⟨b⟩").is_match(&bare) || !re(&PUSH, "⟨b⟩(?i-u:push)⟨b⟩").is_match(&bare) {
        return None;
    }
    let allowed = re(
        &ALLOWED,
        r#"^(?:cd [^⟨WS⟩;&|$`"'()<>*?{}\\]+ && )?git push(?: -u| --set-upstream)? origin vlad/(T[0-9]{8}-[0-9]+)(?: 2>&1)?$"#,
    );
    let Some(m) = allowed.captures(c) else { return Some(NOT_PATTERN) };
    if let Some(id) = own_id {
        if &m[1] != id {
            return Some(NOT_OWN);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "T20261112-10";

    // test/hooks/push-guard.test.ts vakaları
    #[test]
    fn allowed_forms() {
        for cmd in [
            format!("git push origin vlad/{ID}"), format!("git push -u origin vlad/{ID}"), format!("git push --set-upstream origin vlad/{ID}"),
            format!("git push origin vlad/{ID} 2>&1"), format!("cd /Users/x/dev/vlad-wt/{ID} && git push origin vlad/{ID}"),
            format!("  git push -u origin vlad/{ID}  "), format!("git push origin \\\nvlad/{ID}"),
        ] {
            assert_eq!(check_worker_push(&cmd, Some(ID)), None, "{cmd:?}");
        }
    }

    #[test]
    fn rejected_bypasses() {
        let id = ID;
        for cmd in [
            format!("git push origin vlad/{id} +main"), format!("git push origin +vlad/{id}"), format!("git push origin vlad/{id} main"),
            format!("git push -u origin vlad/{id} main"), format!("git push origin vlad/{id}:main"), format!("git push origin HEAD:vlad/{id}"),
            format!("git push origin :vlad/{id}"), format!("git push -uvf origin vlad/{id}"), format!("git push -fu origin vlad/{id}"),
            format!("git push --no-verify origin vlad/{id}"), format!("git push origin vlad/{id} --no-verify"), "git push --mirror origin".into(),
            format!("git push --prune origin vlad/{id}"), format!("git push -o x=y origin vlad/{id}"), format!("git push --force-with-lease origin vlad/{id}"),
            format!("git push --delete origin vlad/{id}"), "git push origin vlad/T20261112-99".into(), "git push origin main".into(), "git push".into(),
            format!("git push upstream vlad/{id}"), "git push --all origin".into(), "git push --tags origin".into(),
            format!("git push origin vlad/{id} && git push origin main"), format!("git push origin vlad/{id}; git push -f origin main"),
            format!("git push origin vlad/{id} | tail -3"), format!("git push origin vlad/{id} > /tmp/x"), "git push origin $(echo main)".into(),
            format!("git push origin 'vlad/{id}'"), format!("git push origin vlad/{id}$X"), format!("git -c remote.origin.pushurl=/x push origin vlad/{id}"),
            format!("git -c core.hooksPath=/x push origin vlad/{id}"), format!("git -C /w push origin vlad/{id}"), format!("git --git-dir=/g push origin vlad/{id}"),
            "git >/dev/null push origin main".into(), format!("timeout 30 git push origin vlad/{id}:main"), format!("timeout 30 git push origin vlad/{id}"),
            format!("nohup git push origin vlad/{id}"), "env -i git push origin main".into(), "time git push origin main".into(),
            "true & git push origin main".into(), "(git push origin main)".into(), "if true; then git push origin main; fi".into(),
            "{ git push origin main; }".into(), "FOO=1 git push origin main".into(), "command git push origin main".into(), "/usr/bin/git push origin main".into(),
            "bash -lc 'git push origin main'".into(), "sh -ec 'git push -f origin main'".into(), "echo $(git push -f origin main)".into(),
            "git -c alias.p=push p origin +main".into(), "git config alias.p push".into(), "git 'push' origin main".into(),
            format!("git \"push\" origin vlad/{id}:main"), "\"git\" push origin +main".into(), "git p\\ush origin main".into(),
            "git \\\npush --force origin main".into(), "git \\\r\npush origin main".into(), "git push \\\n--force origin vlad/T20261112-10".into(),
            format!("cd x && git push origin vlad/{id}:main"), format!("cd x; git push origin vlad/{id}"), format!("git push origin vlad/{id}\ngit push -f origin main"),
            "git commit -m \"fix; git push guard\"".into(), "git log --grep='git push'".into(),
        ] {
            assert!(check_worker_push(&cmd, Some(ID)).is_some(), "{cmd:?}");
        }
    }

    #[test]
    fn case_insensitive_trigger() {
        // F-vlad-405: macOS/Windows'ta `GIT push` git'i çalıştırır; tetik harf duyarsız, ALLOWED küçük harf kalır → ret
        for cmd in ["GIT push --force origin main", &format!("Git push origin vlad/{ID}"), "git PUSH origin main", "gIt Push -f origin main", &format!("GIT -C /w PUSH origin vlad/{ID}"), "G\"I\"T push origin main"] {
            assert_eq!(check_worker_push(cmd, Some(ID)), Some(NOT_PATTERN), "{cmd:?}");
        }
        assert_eq!(check_worker_push("GIT status", Some(ID)), None);
        // JS /i (non-unicode) ASCII dışını ASCII'ye katlamaz: ı/İ/ſ eşleşmez
        assert_eq!(check_worker_push("gıt push", Some(ID)), None);
        assert_eq!(check_worker_push("git puſh", Some(ID)), None);
    }

    #[test]
    fn untouched_commands() {
        for cmd in ["git status", "git pull origin main", "npm test", "git log --oneline", "git commit -m \"fix alias.foo\"", "git config --get alias.p", "git commit -F /tmp/msg", "echo push"] {
            assert_eq!(check_worker_push(cmd, Some(ID)), None, "{cmd:?}");
        }
    }

    #[test]
    fn unknown_id_and_messages() {
        assert_eq!(check_worker_push("git push origin vlad/T20261112-10", None), None);
        assert_eq!(check_worker_push("git push origin vlad/main", None), Some(NOT_PATTERN));
        assert_eq!(check_worker_push("git push origin vlad/T20261112-99", Some(ID)), Some(NOT_OWN));
        // JS \s: U+FEFF boşluk, \b ASCII
        assert_eq!(check_worker_push("\u{FEFF}git push origin vlad/T20261112-10\u{FEFF}", Some(ID)), None);
        assert_eq!(check_worker_push("égit épush", Some(ID)), Some(NOT_PATTERN));
        assert_eq!(check_worker_push("git\u{85}push", Some(ID)), Some(NOT_PATTERN)); // NEL sözcük karakteri değil: iki sözcük de var
        assert_eq!(check_worker_push("gitpush", Some(ID)), None);
    }
}
