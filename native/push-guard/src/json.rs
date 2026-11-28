//! `JSON.parse` ile aynı kabul kümesine sahip, yinelemeli (yığın taşmasız) ayrıştırıcı. Ağaç kurmaz; yalnız kancanın
//! okuduğu alanları tutar: üst nesnede `tool_name`, `cwd`, `tool_input`; `tool_input` nesnesinde bilinen anahtarlar.
//! Tek vekil kaçışları (`\ud800`) JSON.parse gibi kabul edilir ve U+FFFD'ye çevrilir (Node stderr/fs'e yazarken aynısını yapar).

#[derive(Debug, Clone, PartialEq, Default)]
pub enum Val {
    /// Anahtar yok (undefined)
    #[default]
    Missing,
    Null,
    Str(String),
    /// sayı ya da bool
    Other,
    Obj,
    Arr,
}

impl Val {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Val::Str(s) => Some(s),
            _ => None,
        }
    }
    /// `??` için: undefined/null mu
    pub fn is_nullish(&self) -> bool {
        matches!(self, Val::Missing | Val::Null)
    }
}

pub const INPUT_KEYS: [&str; 6] = ["command", "file_path", "notebook_path", "path", "pattern", "glob"];

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ToolInput {
    /// `tool_input` bir nesne mi (değilse tüm alanlar undefined)
    pub fields: [Val; 6],
}

impl ToolInput {
    pub fn get(&self, key: &str) -> &Val {
        let i = INPUT_KEYS.iter().position(|k| *k == key).expect("bilinen anahtar");
        &self.fields[i]
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Payload {
    /// Üst değer nesne mi (değilse `j?.x` hep undefined)
    pub is_object: bool,
    pub tool_name: Val,
    pub cwd: Val,
    pub tool_input: Option<ToolInput>,
}

#[derive(Clone, Copy, PartialEq)]
enum Slot {
    Root,
    Top(usize),
    Nested(usize),
    Ignore,
}

#[derive(Clone, Copy, PartialEq)]
enum Role {
    Top,
    Nested,
    Plain,
}

/// Ayrıştırma şeması: üst nesnede izlenen anahtarlar; `nested` = (üst anahtar sırası, o nesnede izlenen anahtarlar).
struct Spec<'k> {
    top: &'k [&'k str],
    nested: (usize, &'k [&'k str]),
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub enum Kind {
    #[default]
    Scalar,
    Object,
    Array,
}

#[derive(Debug, Default)]
struct Scan {
    kind: Kind,
    top: Vec<Val>,
    /// izlenen üst anahtarın SON değeri nesneyse onun alanları
    nested: Option<Vec<Val>>,
}

struct Frame {
    is_obj: bool,
    role: Role,
}

struct P<'a> {
    s: &'a str,
    b: &'a [u8],
    pos: usize,
}

fn err<T>(msg: &str, pos: usize) -> Result<T, String> {
    Err(format!("{} in JSON at position {}", msg, pos))
}

impl<'a> P<'a> {
    fn ws(&mut self) {
        while self.pos < self.b.len() && matches!(self.b[self.pos], b' ' | b'\t' | b'\n' | b'\r') {
            self.pos += 1;
        }
    }
    fn peek(&self) -> Option<u8> {
        self.b.get(self.pos).copied()
    }
    fn hex4(&mut self) -> Result<u16, String> {
        if self.pos + 4 > self.b.len() {
            return err("Bad Unicode escape", self.pos);
        }
        // önce bayt denetimi: ASCII olmayan bayt varken dilimleme karakter sınırını bölebilir
        if !self.b[self.pos..self.pos + 4].iter().all(|c| c.is_ascii_hexdigit()) {
            return err("Bad Unicode escape", self.pos);
        }
        let h = &self.s[self.pos..self.pos + 4];
        self.pos += 4;
        Ok(u16::from_str_radix(h, 16).unwrap())
    }
    /// `"` sonrası; `decode` false ise yalnız doğrular.
    fn string(&mut self, decode: bool) -> Result<Option<String>, String> {
        let mut out = String::new();
        let mut run = self.pos;
        loop {
            let Some(c) = self.peek() else { return err("Unterminated string", self.pos) };
            match c {
                b'"' => {
                    if decode {
                        out.push_str(&self.s[run..self.pos]);
                    }
                    self.pos += 1;
                    return Ok(decode.then_some(out));
                }
                0..=0x1F => return err("Bad control character in string literal", self.pos),
                b'\\' => {
                    if decode {
                        out.push_str(&self.s[run..self.pos]);
                    }
                    self.pos += 1;
                    let Some(e) = self.peek() else { return err("Unterminated string", self.pos) };
                    self.pos += 1;
                    let ch: char = match e {
                        b'"' => '"',
                        b'\\' => '\\',
                        b'/' => '/',
                        b'b' => '\u{8}',
                        b'f' => '\u{C}',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        b'u' => {
                            let u = self.hex4()?;
                            if (0xD800..0xDC00).contains(&u) {
                                // yüksek vekil: ardından düşük vekil kaçışı gelirse birleşir
                                let save = self.pos;
                                if self.b.get(self.pos) == Some(&b'\\') && self.b.get(self.pos + 1) == Some(&b'u') {
                                    self.pos += 2;
                                    match self.hex4() {
                                        Ok(l) if (0xDC00..0xE000).contains(&l) => {
                                            char::from_u32(0x10000 + (((u as u32) - 0xD800) << 10) + ((l as u32) - 0xDC00)).unwrap()
                                        }
                                        _ => {
                                            self.pos = save; // sonraki kaçış kendi başına ayrıştırılır (geçersizse orada hata)
                                            '\u{FFFD}'
                                        }
                                    }
                                } else {
                                    '\u{FFFD}'
                                }
                            } else {
                                char::from_u32(u as u32).unwrap_or('\u{FFFD}')
                            }
                        }
                        _ => return err("Bad escaped character", self.pos - 1),
                    };
                    if decode {
                        out.push(ch);
                    }
                    run = self.pos;
                }
                _ => self.pos += 1,
            }
        }
    }
    fn digits(&mut self) -> usize {
        let st = self.pos;
        while self.peek().is_some_and(|c| c.is_ascii_digit()) {
            self.pos += 1;
        }
        self.pos - st
    }
    fn number(&mut self) -> Result<(), String> {
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        match self.peek() {
            Some(b'0') => self.pos += 1,
            Some(b'1'..=b'9') => {
                self.digits();
            }
            _ => return err("No number after minus sign", self.pos),
        }
        if self.peek() == Some(b'.') {
            self.pos += 1;
            if self.digits() == 0 {
                return err("Unterminated fractional number", self.pos);
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            if self.digits() == 0 {
                return err("Exponent part is missing a number", self.pos);
            }
        }
        Ok(())
    }
    fn lit(&mut self, w: &str) -> Result<(), String> {
        if self.s[self.pos..].starts_with(w) {
            self.pos += w.len();
            Ok(())
        } else {
            err("Unexpected token", self.pos)
        }
    }
    /// Nesne anahtarı (`"` üzerinde) + `:`; anahtarın gideceği yuva.
    fn key(&mut self, role: Role, spec: &Spec) -> Result<Slot, String> {
        if self.peek() != Some(b'"') {
            return err("Expected property name", self.pos);
        }
        self.pos += 1;
        let k = self.string(role != Role::Plain)?;
        self.ws();
        if self.peek() != Some(b':') {
            return err("Expected ':' after property name", self.pos);
        }
        self.pos += 1;
        let pick = |keys: &[&str], k: &str| keys.iter().position(|x| *x == k);
        Ok(match (role, k.as_deref()) {
            (Role::Top, Some(k)) => pick(spec.top, k).map_or(Slot::Ignore, Slot::Top),
            (Role::Nested, Some(k)) => pick(spec.nested.1, k).map_or(Slot::Ignore, Slot::Nested),
            _ => Slot::Ignore,
        })
    }
}

fn assign(out: &mut Scan, spec: &Spec, slot: Slot, v: Val) {
    match slot {
        Slot::Top(i) => {
            if i == spec.nested.0 {
                out.nested = None; // nesne olmayan değer öncekini ezer
            }
            out.top[i] = v;
        }
        Slot::Nested(i) => {
            if let Some(n) = out.nested.as_mut() {
                n[i] = v;
            }
        }
        Slot::Root | Slot::Ignore => {}
    }
}

fn scan(raw: &str, spec: &Spec) -> Result<Scan, String> {
    let mut p = P { s: raw, b: raw.as_bytes(), pos: 0 };
    let mut out = Scan { top: vec![Val::Missing; spec.top.len()], ..Default::default() };
    let mut stack: Vec<Frame> = Vec::new();
    let mut slot = Slot::Root;
    'value: loop {
        p.ws();
        match p.peek() {
            None => return err("Unexpected end of JSON input", p.pos),
            Some(b'{') => {
                p.pos += 1;
                let role = match slot {
                    Slot::Root => {
                        out.kind = Kind::Object;
                        Role::Top
                    }
                    Slot::Top(i) if i == spec.nested.0 => {
                        out.top[i] = Val::Obj;
                        out.nested = Some(vec![Val::Missing; spec.nested.1.len()]);
                        Role::Nested
                    }
                    s => {
                        assign(&mut out, spec, s, Val::Obj);
                        Role::Plain
                    }
                };
                stack.push(Frame { is_obj: true, role });
                p.ws();
                if p.peek() == Some(b'}') {
                    p.pos += 1;
                    stack.pop();
                } else {
                    slot = p.key(role, spec)?;
                    continue 'value;
                }
            }
            Some(b'[') => {
                p.pos += 1;
                if slot == Slot::Root {
                    out.kind = Kind::Array;
                }
                assign(&mut out, spec, slot, Val::Arr);
                stack.push(Frame { is_obj: false, role: Role::Plain });
                p.ws();
                if p.peek() == Some(b']') {
                    p.pos += 1;
                    stack.pop();
                } else {
                    slot = Slot::Ignore;
                    continue 'value;
                }
            }
            Some(b'"') => {
                p.pos += 1;
                let need = matches!(slot, Slot::Top(_) | Slot::Nested(_));
                let v = p.string(need)?;
                assign(&mut out, spec, slot, v.map_or(Val::Other, Val::Str));
            }
            Some(b't') => {
                p.lit("true")?;
                assign(&mut out, spec, slot, Val::Other);
            }
            Some(b'f') => {
                p.lit("false")?;
                assign(&mut out, spec, slot, Val::Other);
            }
            Some(b'n') => {
                p.lit("null")?;
                assign(&mut out, spec, slot, Val::Null);
            }
            Some(b'-' | b'0'..=b'9') => {
                p.number()?;
                assign(&mut out, spec, slot, Val::Other);
            }
            Some(_) => return err("Unexpected token", p.pos),
        }
        // değer bitti: kapsayıcıda devam
        loop {
            let Some(top) = stack.last() else { break 'value };
            let (is_obj, role) = (top.is_obj, top.role);
            p.ws();
            match (is_obj, p.peek()) {
                (_, Some(b',')) => {
                    p.pos += 1;
                    if is_obj {
                        p.ws();
                        slot = p.key(role, spec)?;
                    } else {
                        slot = Slot::Ignore;
                    }
                    continue 'value;
                }
                (true, Some(b'}')) | (false, Some(b']')) => {
                    p.pos += 1;
                    stack.pop();
                }
                (_, None) => return err("Unexpected end of JSON input", p.pos),
                _ => return err("Unexpected token", p.pos),
            }
        }
    }
    p.ws();
    if p.pos != p.b.len() {
        return err("Unexpected non-whitespace character after JSON", p.pos);
    }
    Ok(out)
}

/// Kanca girdisi (`JSON.parse(raw)`).
pub fn parse(raw: &str) -> Result<Payload, String> {
    let s = scan(raw, &Spec { top: &["tool_name", "cwd", "tool_input"], nested: (2, &INPUT_KEYS) })?;
    let mut top = s.top.into_iter();
    Ok(Payload {
        is_object: s.kind == Kind::Object,
        tool_name: top.next().unwrap(),
        cwd: top.next().unwrap(),
        tool_input: s.nested.map(|f| ToolInput { fields: f.try_into().unwrap() }),
    })
}

/// Config dosyası (config-layer.ts `readObject`): üst değerin türü, kendi `kbDir`'i, kendi `__proto__`'su ve o
/// nesneyse onun `kbDir`'i (JS'te `merged.__proto__ = v` prototipi değiştirir; `.kbDir` oradan okunabilir).
#[derive(Debug, Clone, PartialEq)]
pub struct ConfigObj {
    pub kind: Kind,
    pub kb_dir: Val,
    pub proto: Val,
    pub proto_kb_dir: Val,
}

pub fn parse_config(raw: &str) -> Result<ConfigObj, String> {
    let s = scan(raw, &Spec { top: &["kbDir", "__proto__"], nested: (1, &["kbDir"]) })?;
    let proto_kb_dir = s.nested.map_or(Val::Missing, |mut n| n.remove(0));
    let mut top = s.top.into_iter();
    Ok(ConfigObj { kind: s.kind, kb_dir: top.next().unwrap(), proto: top.next().unwrap(), proto_kb_dir })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(s: &str) -> Payload {
        parse(s).unwrap_or_else(|e| panic!("{s}: {e}"))
    }
    fn bad(s: &str) {
        assert!(parse(s).is_err(), "kabul edilmemeliydi: {s:?}");
    }

    #[test]
    fn basic_fields() {
        let p = ok(r#"{"tool_name":"Bash","tool_input":{"command":"ls","x":[1,{"a":null}]},"cwd":"/x"}"#);
        assert!(p.is_object);
        assert_eq!(p.tool_name, Val::Str("Bash".into()));
        assert_eq!(p.cwd, Val::Str("/x".into()));
        let ti = p.tool_input.unwrap();
        assert_eq!(ti.get("command"), &Val::Str("ls".into()));
        assert_eq!(ti.get("file_path"), &Val::Missing);
    }

    #[test]
    fn value_kinds_and_duplicates() {
        let p = ok(r#"{"tool_name":1,"tool_name":"Read","cwd":null,"tool_input":{"file_path":null,"notebook_path":5}}"#);
        assert_eq!(p.tool_name, Val::Str("Read".into()));
        assert_eq!(p.cwd, Val::Null);
        let ti = p.tool_input.unwrap();
        assert_eq!(ti.get("file_path"), &Val::Null);
        assert_eq!(ti.get("notebook_path"), &Val::Other);
        // sonraki tool_input öncekini tümüyle ezer
        let p = ok(r#"{"tool_input":{"command":"a"},"tool_input":{"path":"b"}}"#);
        let ti = p.tool_input.unwrap();
        assert_eq!(ti.get("command"), &Val::Missing);
        assert_eq!(ti.get("path"), &Val::Str("b".into()));
        let p = ok(r#"{"tool_input":{"command":"a"},"tool_input":"x"}"#);
        assert_eq!(p.tool_input, None);
    }

    #[test]
    fn nested_fields_not_captured() {
        let p = ok(r#"{"a":{"tool_name":"Bash"},"tool_input":{"z":{"command":"x"}}}"#);
        assert_eq!(p.tool_name, Val::Missing);
        assert_eq!(p.tool_input.unwrap().get("command"), &Val::Missing);
    }

    #[test]
    fn non_object_tops() {
        for s in ["null", "1", "\"x\"", "[1,2]", "true", " -0.5e+3 "] {
            let p = ok(s);
            assert!(!p.is_object);
            assert_eq!(p.tool_name, Val::Missing);
        }
    }

    #[test]
    fn escapes_and_surrogates() {
        let p = ok(r#"{"tool\u005fname":"a\"b\\c\/d\b\f\n\r\t\u00e7\ud83d\ude00\ud800x\udc00"}"#);
        assert_eq!(p.tool_name, Val::Str("a\"b\\c/d\u{8}\u{c}\n\r\tç😀\u{FFFD}x\u{FFFD}".into()));
        let p = ok("{\"tool_name\":\"\u{2028}\"}");
        assert_eq!(p.tool_name, Val::Str("\u{2028}".into()));
    }

    #[test]
    fn rejects_like_json_parse() {
        for s in [
            "", " ", "{", "{bozuk", "{\"a\":1,}", "[1,]", "01", "1.", ".5", "-", "1e", "+1", "{'a':1}", "{\"a\" 1}",
            "\"\\x\"", "\"\\u12\"", "\"a\u{1}\"", "nul", "truee", "{} x", "\u{FEFF}{}", "[1 2]", "{\"a\":}", "\"\t\"",
            "{\"a\":1 \"b\":2}", "[", "]", "{\"a\"}", "NaN", "Infinity", "\"\\uD800\\u\"",
        ] {
            bad(s);
        }
    }

    #[test]
    fn accepts_like_json_parse() {
        for s in ["{}", "[]", " \t\n\r{} \n", "[[[[]]]]", "-0", "0.0e-0", "1E5", "[\"\\u0000\"]", "{\"\":{\"\":[]}}", "\"\u{7f}\""] {
            ok(s);
        }
    }

    #[test]
    fn config_fields() {
        let c = parse_config(r#"{"kbDir":"../kb","__proto__":{"kbDir":"/p","x":1},"y":{"kbDir":"no"}}"#).unwrap();
        assert_eq!(c.kind, Kind::Object);
        assert_eq!(c.kb_dir, Val::Str("../kb".into()));
        assert_eq!(c.proto, Val::Obj);
        assert_eq!(c.proto_kb_dir, Val::Str("/p".into()));
        let c = parse_config(r#"{"__proto__":{"kbDir":"/p"},"__proto__":[1]}"#).unwrap();
        assert_eq!((c.proto, c.proto_kb_dir), (Val::Arr, Val::Missing));
        assert_eq!(parse_config("[1]").unwrap().kind, Kind::Array);
        assert_eq!(parse_config("null").unwrap().kind, Kind::Scalar);
    }

    #[test]
    fn deep_nesting_no_stack_overflow() {
        let s = format!("{}{}", "[".repeat(200_000), "]".repeat(200_000));
        assert!(!ok(&s).is_object);
        let s = format!("{{\"tool_input\":{}1{}}}", "[".repeat(100_000), "]".repeat(100_000));
        assert_eq!(ok(&s).tool_input, None);
        bad(&"[".repeat(100_000));
    }
}
