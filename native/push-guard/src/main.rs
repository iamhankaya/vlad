//! VLAD PreToolUse push-guard kancası — src/hooks/push-guard-hook.ts'in birebir Rust taşıması (D-vlad-093).
//! stdin: Claude Code araç girdisi JSON'u. Çıkış 0 = serbest, 2 = ret (stderr'de neden), 1 = beklenmeyen hata.
#![forbid(unsafe_code)]
mod hook;
mod json;
mod jsre;
mod mode_guard;
mod path;
mod push_guard;
mod sys;
mod text;

use std::io::{Read, Write};

fn main() {
    // panik catch yoluna gider (hook::run); varsayılan kanca stderr'e "thread 'main' panicked" basmasın (M1)
    std::panic::set_hook(Box::new(|_| {}));
    let mut buf = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut buf);
    // Node `setEncoding("utf8")`: geçersiz bayt dizileri U+FFFD
    let raw = String::from_utf8_lossy(&buf);
    let code = match hook::run(&raw) {
        hook::Outcome::Allow => 0,
        hook::Outcome::Block(msg) => {
            let _ = std::io::stderr().write_all(format!("{}\n", msg).as_bytes());
            2
        }
        hook::Outcome::Crash(msg) => {
            let _ = std::io::stderr().write_all(format!("{}\n", msg).as_bytes());
            1
        }
    };
    std::process::exit(code);
}
