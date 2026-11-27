//! Node `path.posix` birebir: resolve, normalize, join, dirname, basename, isAbsolute.
//! Ayraç ve nokta ASCII olduğundan bayt düzeyinde çalışmak UTF-16 sonuçlarıyla aynıdır.

use crate::sys;

/// Node `normalizeString` (posix).
fn normalize_string(path: &str, allow_above_root: bool) -> String {
    let b = path.as_bytes();
    let mut res = String::new();
    let mut last_segment_length: usize = 0;
    let mut last_slash: isize = -1;
    let mut dots: i32 = 0;
    let mut code: u8 = 0;
    let n = b.len();
    let mut i = 0usize;
    while i <= n {
        if i < n {
            code = b[i];
        } else if code == b'/' {
            break;
        } else {
            code = b'/';
        }
        if code == b'/' {
            if last_slash == i as isize - 1 || dots == 1 {
                // NOOP
            } else if dots == 2 {
                let rb = res.as_bytes();
                if rb.len() < 2 || last_segment_length != 2 || rb[rb.len() - 1] != b'.' || rb[rb.len() - 2] != b'.' {
                    if rb.len() > 2 {
                        match res.rfind('/') {
                            None => {
                                res.clear();
                                last_segment_length = 0;
                            }
                            Some(idx) => {
                                res.truncate(idx);
                                last_segment_length = match res.rfind('/') {
                                    Some(j) => res.len() - 1 - j,
                                    None => res.len(), // len - 1 - (-1)
                                };
                            }
                        }
                        last_slash = i as isize;
                        dots = 0;
                        i += 1;
                        continue;
                    } else if !rb.is_empty() {
                        res.clear();
                        last_segment_length = 0;
                        last_slash = i as isize;
                        dots = 0;
                        i += 1;
                        continue;
                    }
                }
                if allow_above_root {
                    if res.is_empty() {
                        res.push_str("..");
                    } else {
                        res.push_str("/..");
                    }
                    last_segment_length = 2;
                }
            } else {
                let seg = &path[(last_slash + 1) as usize..i];
                if !res.is_empty() {
                    res.push('/');
                }
                res.push_str(seg);
                last_segment_length = i - (last_slash + 1) as usize;
            }
            last_slash = i as isize;
            dots = 0;
        } else if code == b'.' && dots != -1 {
            dots += 1;
        } else {
            dots = -1;
        }
        i += 1;
    }
    res
}

/// `path.resolve(...args)`; göreli kalırsa `process.cwd()` (çözülemezse hata: Node fırlatır).
pub fn resolve(args: &[&str]) -> Result<String, String> {
    let mut resolved = String::new();
    let mut absolute = false;
    let mut cwd_holder: Option<String>;
    let mut i = args.len() as isize - 1;
    while i >= -1 && !absolute {
        let p: &str = if i >= 0 {
            args[i as usize]
        } else {
            cwd_holder = Some(sys::process_cwd()?);
            cwd_holder.as_deref().unwrap_or_default()
        };
        i -= 1;
        if p.is_empty() {
            continue;
        }
        resolved = format!("{}/{}", p, resolved);
        absolute = p.as_bytes()[0] == b'/';
    }
    let norm = normalize_string(&resolved, !absolute);
    if absolute {
        return Ok(format!("/{}", norm));
    }
    Ok(if norm.is_empty() { ".".to_string() } else { norm })
}

pub fn normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".into();
    }
    let abs = path.starts_with('/');
    let trailing = path.ends_with('/');
    let mut p = normalize_string(path, !abs);
    if p.is_empty() {
        if abs {
            return "/".into();
        }
        return if trailing { "./".into() } else { ".".into() };
    }
    if trailing {
        p.push('/');
    }
    if abs {
        format!("/{}", p)
    } else {
        p
    }
}

pub fn join(args: &[&str]) -> String {
    let parts: Vec<&str> = args.iter().copied().filter(|s| !s.is_empty()).collect();
    if parts.is_empty() {
        return ".".into();
    }
    normalize(&parts.join("/"))
}

pub fn dirname(path: &str) -> String {
    let b = path.as_bytes();
    if b.is_empty() {
        return ".".into();
    }
    let has_root = b[0] == b'/';
    let mut end: isize = -1;
    let mut matched_slash = true;
    let mut i = b.len() as isize - 1;
    while i >= 1 {
        if b[i as usize] == b'/' {
            if !matched_slash {
                end = i;
                break;
            }
        } else {
            matched_slash = false;
        }
        i -= 1;
    }
    if end == -1 {
        return if has_root { "/".into() } else { ".".into() };
    }
    if has_root && end == 1 {
        return "//".into();
    }
    path[..end as usize].to_string()
}

pub fn basename(path: &str) -> String {
    let b = path.as_bytes();
    let mut start = 0usize;
    let mut end: isize = -1;
    let mut matched_slash = true;
    let mut i = b.len() as isize - 1;
    while i >= 0 {
        if b[i as usize] == b'/' {
            if !matched_slash {
                start = i as usize + 1;
                break;
            }
        } else if end == -1 {
            matched_slash = false;
            end = i + 1;
        }
        i -= 1;
    }
    if end == -1 {
        return String::new();
    }
    path[start..end as usize].to_string()
}

pub fn is_absolute(p: &str) -> bool {
    p.starts_with('/')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_absolute() {
        assert_eq!(resolve(&["/a/b", "../c"]).unwrap(), "/a/c");
        assert_eq!(resolve(&["/a", "/b", "c/"]).unwrap(), "/b/c");
        assert_eq!(resolve(&["/", ".."]).unwrap(), "/");
        assert_eq!(resolve(&["/a//b/./c/.."]).unwrap(), "/a/b");
        assert_eq!(resolve(&["/a", "", "b"]).unwrap(), "/a/b");
        assert_eq!(resolve(&["//x"]).unwrap(), "/x");
        assert_eq!(resolve(&["/a/...", "..b"]).unwrap(), "/a/.../..b");
    }

    #[test]
    fn resolve_relative_uses_cwd() {
        let cwd = sys::process_cwd().unwrap();
        assert_eq!(resolve(&["x"]).unwrap(), format!("{}/x", if cwd == "/" { "" } else { &cwd }));
    }

    #[test]
    fn normalize_cases() {
        assert_eq!(normalize(""), ".");
        assert_eq!(normalize("./"), "./");
        assert_eq!(normalize("a/../.."), "..");
        assert_eq!(normalize("a/b/../../../c/"), "../c/");
        assert_eq!(normalize("/../a"), "/a");
        assert_eq!(normalize("../../x/.."), "../..");
    }

    #[test]
    fn join_cases() {
        assert_eq!(join(&["", ""]), ".");
        assert_eq!(join(&["/kb", "mode.json"]), "/kb/mode.json");
        assert_eq!(join(&["", ".vlad-secret"]), ".vlad-secret");
        assert_eq!(join(&["a/", "/b"]), "a/b");
    }

    #[test]
    fn dirname_cases() {
        assert_eq!(dirname(""), ".");
        assert_eq!(dirname("/"), "/");
        assert_eq!(dirname("//a"), "//");
        assert_eq!(dirname("/a/b/"), "/a");
        assert_eq!(dirname("a"), ".");
        assert_eq!(dirname("/a"), "/");
        assert_eq!(dirname("a//b"), "a/");
    }

    #[test]
    fn basename_cases() {
        assert_eq!(basename(""), "");
        assert_eq!(basename("/"), "");
        assert_eq!(basename("/a/b/"), "b");
        assert_eq!(basename("a"), "a");
        assert_eq!(basename("x/mode.json"), "mode.json");
        assert_eq!(basename("ç/ö"), "ö");
    }
}
