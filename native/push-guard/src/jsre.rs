//! mode-guard.ts `globHits` / `segMatches`: kullanıcı jokerinden üretilen JS regex'i (`new RegExp(…, "i")`, unicode
//! bayrağı yok) birebir yorumlar. Üretilen kaynakta yalnız şunlar olabilir: düz karakter, kimlik kaçışı (`\.` …), `.`,
//! `*` niceleyici, `[…]` sınıfı (aralık, olumsuzlama). Eşleştirme UTF-16 kod birimleri üzerinde, ES `Canonicalize` ile.

use crate::text::{canonicalize, lower, utf16};
use std::collections::HashSet;

enum Atom {
    Lit(u16),
    Any,
    Class { set: HashSet<u16>, negated: bool },
}

struct Tok {
    atom: Atom,
    star: bool,
}

const LT: [u16; 4] = [0x0A, 0x0D, 0x2028, 0x2029];

/// JS regex kaynağı (bu alt küme) → belirteçler; SyntaxError = Err.
fn compile(src: &[u16]) -> Result<Vec<Tok>, ()> {
    let mut out: Vec<Tok> = Vec::new();
    let mut i = 0;
    while i < src.len() {
        let c = src[i];
        let atom = match c {
            0x5C => {
                // `\X` kimlik kaçışı; sonda tek `\` = SyntaxError
                let Some(&n) = src.get(i + 1) else { return Err(()) };
                i += 2;
                Atom::Lit(n)
            }
            0x2E => {
                i += 1;
                Atom::Any
            }
            0x2A => {
                // `*`: önceki atomu niceler; önceki yoksa ya da zaten nicelenmişse SyntaxError
                match out.last_mut() {
                    Some(t) if !t.star => t.star = true,
                    _ => return Err(()),
                }
                i += 1;
                continue;
            }
            0x5B => {
                let (set, negated, next) = class(src, i + 1)?;
                i = next;
                Atom::Class { set, negated }
            }
            // bu alt kümede üretilmeyen metakarakterler: güvenli tarafta SyntaxError say (TS: catch → true)
            0x28 | 0x29 | 0x7C | 0x2B | 0x3F | 0x5E | 0x24 | 0x7B | 0x7D => return Err(()),
            _ => {
                i += 1;
                Atom::Lit(c)
            }
        };
        out.push(Tok { atom, star: false });
    }
    Ok(out)
}

/// `[` sonrası sınıf; kanonik üye kümesi, olumsuz mu, `]` sonrası konum.
fn class(src: &[u16], mut i: usize) -> Result<(HashSet<u16>, bool, usize), ()> {
    let mut negated = false;
    if src.get(i) == Some(&0x5E) {
        negated = true;
        i += 1;
    }
    let mut set = HashSet::new();
    let atom = |i: &mut usize| -> Result<u16, ()> {
        let c = *src.get(*i).ok_or(())?;
        if c == 0x5C {
            let n = *src.get(*i + 1).ok_or(())?;
            *i += 2;
            return Ok(n);
        }
        *i += 1;
        Ok(c)
    };
    loop {
        let Some(&c) = src.get(i) else { return Err(()) }; // kapanmamış sınıf
        if c == 0x5D {
            return Ok((set, negated, i + 1));
        }
        let a = atom(&mut i)?;
        // aralık: `a-b` (b `]` değilse); `-` sonda düz karakter
        if src.get(i) == Some(&0x2D) && src.get(i + 1).is_some_and(|&n| n != 0x5D) {
            i += 1;
            let b = atom(&mut i)?;
            if a > b {
                return Err(()); // Range out of order
            }
            for x in a..=b {
                set.insert(canonicalize(x));
            }
        } else {
            set.insert(canonicalize(a));
        }
    }
}

fn atom_matches(a: &Atom, ch: u16) -> bool {
    match a {
        Atom::Lit(l) => canonicalize(*l) == canonicalize(ch),
        Atom::Any => !LT.contains(&ch),
        Atom::Class { set, negated } => set.contains(&canonicalize(ch)) != *negated,
    }
}

/// `^src$` tam eşleşme (geri izleme yerine DP: sonuç aynı, süre sınırlı).
fn full_match(toks: &[Tok], name: &[u16]) -> bool {
    let n = name.len();
    // dp[j] = toks[i..] name[j..]'yi tümüyle eşler
    let mut dp = vec![false; n + 1];
    dp[n] = true;
    for t in toks.iter().rev() {
        let mut nd = vec![false; n + 1];
        for j in (0..=n).rev() {
            nd[j] = if t.star {
                dp[j] || (j < n && atom_matches(&t.atom, name[j]) && nd[j + 1])
            } else {
                j < n && atom_matches(&t.atom, name[j]) && dp[j + 1]
            };
        }
        dp = nd;
    }
    dp[0]
}

fn is_glob(s: &str) -> bool {
    s.contains(['*', '?', '['])
}

fn escape_meta(s: &str) -> String {
    let mut o = String::with_capacity(s.len() * 2);
    for c in s.chars() {
        if ".+^${}()|\\".contains(c) {
            o.push('\\');
        }
        o.push(c);
    }
    o
}

fn test(re: &str, name: &str) -> bool {
    match compile(&utf16(re)) {
        Ok(t) => full_match(&t, &utf16(name)),
        Err(()) => true, // TS: try { new RegExp } catch { return true }
    }
}

/// mode-guard.ts `globHits(base, name)`: K1 — ham ya da APFS katlanmış biçim isabet ederse isabet.
pub fn glob_hits(base: &str, name: &str) -> bool {
    glob_hit1(base, name) || glob_hit1(&crate::text::fold(base), name)
}

fn glob_hit1(base: &str, name: &str) -> bool {
    if !is_glob(base) {
        return lower(base) == name;
    }
    if base.starts_with('*') {
        return false;
    }
    let e = escape_meta(&bracket_loose(base));
    // .replace(/\[[^\]]*\]/g, ".")
    let mut r = String::new();
    let mut rest = e.as_str();
    while let Some(i) = rest.find('[') {
        r.push_str(&rest[..i]);
        match rest[i + 1..].find(']') {
            Some(j) => {
                r.push('.');
                rest = &rest[i + 1 + j + 1..];
            }
            None => {
                r.push('[');
                rest = &rest[i + 1..];
            }
        }
    }
    r.push_str(rest);
    let r = r.replace('*', ".*").replace('?', ".");
    test(&r, name)
}

/// mode-guard.ts `segMatches(globSeg, name)`: K1 — ham çift (kabuk `?` ß'ye açılır) ya da iki tarafı katlanmış çift.
pub fn seg_matches(glob_seg: &str, name: &str) -> bool {
    // review tur 2 + F-vlad-410: POSIX sınıfı / collating / eşdeğerlik / `]` ile başlayan sınıf → `?` (mode-guard.ts bracketLoose)
    let g = bracket_loose(glob_seg);
    let glob_seg = g.as_str();
    seg_match1(glob_seg, name) || seg_match1(&crate::text::fold(glob_seg), &crate::text::fold(name))
}

/// mode-guard.ts `bracketLoose`: köşeli parantez ifadesi JS regex'te yanlış okunur → `?` (fail-closed). POSIX sınıfı (çoklu dahil:
/// `[[:alpha:][:digit:]]`), collating (`[[.o.]]`), eşdeğerlik (`[[=o=]]`) ya da `]` ile başlayan (`[]n]`, `[!]x]`) sınıf; kapanmamış `[` düz karakter.
pub fn bracket_loose(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0usize;
    while i < c.len() {
        if c[i] != '[' {
            out.push(c[i]);
            i += 1;
            continue;
        }
        let mut j = i + 1;
        let mut odd = false;
        if j < c.len() && (c[j] == '!' || c[j] == '^') {
            j += 1;
        }
        if j < c.len() && c[j] == ']' {
            odd = true;
            j += 1;
        }
        let mut end: Option<usize> = None;
        while j < c.len() {
            let ch = c[j];
            if ch == '[' {
                if let Some(&n) = c.get(j + 1) {
                    if ":.=".contains(n) {
                        let mut k = j + 2;
                        let mut close = None;
                        while k + 1 < c.len() {
                            if c[k] == n && c[k + 1] == ']' {
                                close = Some(k);
                                break;
                            }
                            k += 1;
                        }
                        if let Some(cl) = close {
                            odd = true;
                            j = cl + 2; // JS: j = close + 1; continue (for'un j++'ı)
                            continue;
                        }
                    }
                }
            }
            if ch == ']' {
                end = Some(j);
                break;
            }
            j += 1;
        }
        match end {
            None => {
                out.push('[');
                i += 1;
            }
            Some(e) => {
                if odd {
                    out.push('?');
                } else {
                    out.extend(&c[i..=e]);
                }
                i = e + 1;
            }
        }
    }
    out
}

fn seg_match1(glob_seg: &str, name: &str) -> bool {
    if !is_glob(glob_seg) {
        return lower(glob_seg) == lower(name);
    }
    if name.starts_with('.') && !glob_seg.starts_with('.') {
        return false;
    }
    let e = escape_meta(glob_seg).replace("[!", "[^");
    // .replace(/\*+/g, ".*")
    let mut r = String::new();
    let mut prev_star = false;
    for c in e.chars() {
        if c == '*' {
            if !prev_star {
                r.push_str(".*");
            }
            prev_star = true;
        } else {
            prev_star = false;
            r.push(c);
        }
    }
    let r = r.replace('?', ".");
    test(&r, name)
}

#[cfg(test)]
mod tests {
    use super::*;

    // beklenen değerler Node'da mode-guard.ts kopyasıyla üretildi
    #[test]
    fn glob_hits_cases() {
        let cases: &[(&str, &str, bool)] = &[
            ("mode.json", "mode.json", true), ("MODE.JSON", "mode.json", true), ("mod?.json", "mode.json", true),
            ("m*e.json", "mode.json", true), ("mode.jso[n]", "mode.json", true), ("*.json", "mode.json", false),
            ("mode[", "mode.json", true), ("mo]de.json", "mode.json", false), ("m[]ode.json", "mode.json", false),
            ("m[[]de.json", "mode.json", true), ("mode.js?n", "mode.json", true), ("modé.json", "mode.json", false),
            ("m?de.j$on", "mode.json", false), ("setting?.json", "settings.json", true),
            ("settings.*", "settings.local.json", true), ("?ode.json", "mode.json", true),
            ("mode.json?", "mode.json", false), ("ſode.json?", "mode.json", false), ("m*", "mode.json", true),
            ("m(?)de.json", "mode.json", false),
        ];
        for (a, b, want) in cases {
            assert_eq!(glob_hits(a, b), *want, "globHits({a:?}, {b:?})");
        }
    }

    #[test]
    fn seg_matches_cases() {
        let cases: &[(&str, &str, bool)] = &[
            ("*", ".vlad-secret", false), (".*", ".vlad-secret", true), (".v*", ".vlad-secret", true),
            (".?lad-secret", ".vlad-secret", true), ("U*", "Users", true), ("u[a-z]ers", "Users", true),
            ("[!x]sers", "Users", true), ("[]sers", "Users", false), ("[^]sers", "Users", false),
            ("[!]sers", "Users", true), ("[z-a]sers", "Users", true), ("[a-]sers", "Users", false),
            ("[-u]sers", "Users", true), ("[.-z]sers", "Users", true), ("[*]sers", "Users", false),
            ("[?]sers", "Users", false), ("[]]sers", "Users", true), /* review tur 2: `]` ile başlayan sınıf fail-closed `?` */ ("[", "Users", true), ("Us]ers", "Us]ers", true),
            ("**rs", "Users", true), ("u?ers", "Users", true), ("[A-Z]sers", "users", true),
            ("[Z-a]sers", "_sers", true), ("[Z-a]sers", "zsers", true), ("[[]", "[", true), ("[\\]x", "x", false),
            ("[^a]", "^", true), ("[!a]", "b", true), ("users", "USERS", true), ("[ſ]sers", "Ssers", true),
            ("[k]", "\u{212a}", true), ("é*", "Érik", true), ("[é]rik", "Érik", true), // K1: ſ/K satırları APFS katlaması (eskiden false)
            ("stra?", "straß", true), ("stra[ß]", "straß", true), ("stra??", "straß", true), ("?x", "\u{fb01}x", true),
        ];
        for (a, b, want) in cases {
            assert_eq!(seg_matches(a, b), *want, "segMatches({a:?}, {b:?})");
        }
    }
}
