//! JS metin semantiği: `\s` kümesi, `String.prototype.trim`, `toLowerCase`, regex parçaları.

/// JS `\s` = WhiteSpace + LineTerminator (U+FEFF dahil, U+0085 hariç; Rust `\s`'ten farklı).
pub const WS: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

pub fn is_js_ws(c: char) -> bool {
    matches!(c,
        '\t' | '\n' | '\x0B' | '\x0C' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}'
        | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}

/// `String.prototype.trim`.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_ws)
}

/// `toLowerCase` (tam Unicode eşlemesi; Rust `to_lowercase` aynı SpecialCasing kurallarını uygular).
pub fn lower(s: &str) -> String {
    s.to_lowercase()
}

/// Regex kaynağındaki `\s` / `\S` / `\d` / `\w` / `\b` / `.` yer tutucularını JS anlamlı Rust karşılıklarına çevirir:
/// `⟨WS⟩` → sınıf içeriği, `⟨s⟩` → `[WS]`, `⟨S⟩` → `[^WS]`, `⟨b⟩` → ASCII sözcük sınırı, `⟨dot⟩` → satır sonu dışı tek karakter.
pub fn js_re(src: &str) -> String {
    src.replace("⟨WS⟩", WS)
        .replace("⟨s⟩", &format!("[{}]", WS))
        .replace("⟨S⟩", &format!("[^{}]", WS))
        .replace("⟨b⟩", r"(?-u:\b)")
        .replace("⟨dot⟩", r"[^\n\r\x{2028}\x{2029}]")
}

pub fn utf16(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// ES non-unicode `Canonicalize(ch)` (regex `i` bayrağı): tek kod birimine büyük harf; ASCII olmayan → ASCII eşlemesi yok.
pub fn canonicalize(ch: u16) -> u16 {
    let Some(c) = char::from_u32(ch as u32) else { return ch }; // vekil yarımı
    let mut up = c.to_uppercase();
    let (Some(u), None) = (up.next(), up.next()) else { return ch };
    let u = u as u32;
    if u > 0xFFFF {
        return ch;
    }
    if ch >= 128 && u < 128 {
        return ch;
    }
    u as u16
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_js_set() {
        assert_eq!(js_trim("\u{FEFF} a \u{A0}"), "a");
        assert_eq!(js_trim("\u{85}a"), "\u{85}a"); // NEL JS boşluğu değil
    }

    #[test]
    fn canonicalize_rules() {
        assert_eq!(canonicalize('a' as u16), 'A' as u16);
        assert_eq!(canonicalize(0x017F), 0x017F); // ſ → S olmaz (ASCII'ye inmez)
        assert_eq!(canonicalize(0x00DF), 0x00DF); // ß → SS (iki birim) → kendisi
        assert_eq!(canonicalize(0x00E9), 0x00C9);
        assert_eq!(canonicalize(0xD800), 0xD800);
    }

    #[test]
    fn js_re_compiles() {
        let r = regex::Regex::new(&js_re(r"^⟨b⟩git⟨b⟩⟨s⟩+$")).unwrap();
        assert!(r.is_match("git \u{FEFF}"));
        assert!(!r.is_match("git \u{85}"));
        let d = regex::Regex::new(&js_re(r"^⟨S⟩⟨dot⟩$")).unwrap();
        assert!(d.is_match("x\u{85}"));
        assert!(!d.is_match("x\u{2028}"));
        let b = regex::Regex::new(&js_re(r"⟨b⟩push⟨b⟩")).unwrap();
        assert!(b.is_match("é push"));
        assert!(b.is_match("épush")); // JS \b: é sözcük karakteri değil
        assert!(!b.is_match("xpush"));
    }
}
