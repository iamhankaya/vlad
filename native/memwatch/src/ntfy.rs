//! ntfy bildirimi: vlad'ın mevcut kanalını (`~/.vlad-secret/approver/channel.json`, `vlad approver install` yazar) okur,
//! `src/approver/ntfy.ts` `publishNotice` ile aynı biçimde (POST <origin>/, JSON gövde içinde topic) yayınlar.
//! Gönderim `curl` ile: TLS kütüphanesi eklemeden (daemon RSS hedefi). Gizli konu yalnız stdin'deki gövdededir;
//! argv'ye, günlüğe ve hata iletisine yazılmaz. `-q` kullanıcının .curlrc'sini devre dışı bırakır; yönlendirme izlenmez.
use serde::Deserialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Deserialize)]
struct RawChannel {
    v: u32,
    server: String,
    #[serde(rename = "requestTopic")]
    request_topic: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Channel {
    pub origin: String,
    pub topic: String,
}

pub fn default_channel_path() -> Option<PathBuf> {
    std::env::var_os("HOME").filter(|h| !h.is_empty()).map(|h| {
        PathBuf::from(h)
            .join(".vlad-secret")
            .join("approver")
            .join("channel.json")
    })
}

/// `https://host[:port]` ya da yalnız loopback için `http://` (TS NtfyChannel kuralı). Yol/sorgu/kimlik bilgisi reddedilir.
pub fn origin_of(server: &str) -> Result<String, String> {
    let (scheme, rest) = server
        .split_once("://")
        .ok_or("ntfy: geçersiz sunucu adresi")?;
    let hostport = rest.strip_suffix('/').unwrap_or(rest);
    if hostport.is_empty() || hostport.contains(['/', '?', '#', '@', ' ', '\\']) {
        return Err("ntfy: sunucu adresi yalnız origin olmalı".into());
    }
    let host = if let Some(h) = hostport.strip_prefix('[') {
        format!("[{}]", h.split(']').next().unwrap_or(""))
    } else {
        hostport.split(':').next().unwrap_or("").to_string()
    };
    let loopback = matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]");
    match scheme {
        "https" => Ok(format!("https://{hostport}")),
        "http" if loopback => Ok(format!("http://{hostport}")),
        _ => Err("ntfy: sunucu adresi https olmalı".into()),
    }
}

/// Kanal yoksa Ok(None): ntfy kurulmamış, bildirim atlanır (durum dosyası yine yazılır).
pub fn read_channel(path: &Path) -> Result<Option<Channel>, String> {
    let meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("ntfy kanalı okunamadı".into()),
    };
    if !meta.file_type().is_file() || meta.len() > 4096 {
        return Err("ntfy kanalı düz dosya değil ya da çok büyük".into());
    }
    let raw = fs::read(path).map_err(|_| "ntfy kanalı okunamadı".to_string())?;
    let c: RawChannel =
        serde_json::from_slice(&raw).map_err(|_| "ntfy kanalı bozuk".to_string())?;
    if c.v != 1 || c.request_topic.is_empty() || c.request_topic.len() > 128 {
        return Err("ntfy kanalı geçersiz".into());
    }
    Ok(Some(Channel {
        origin: origin_of(&c.server)?,
        topic: c.request_topic,
    }))
}

pub fn payload(ch: &Channel, title: &str, message: &str, critical: bool) -> String {
    serde_json::json!({
        "topic": ch.topic,
        "title": title,
        "message": message,
        "priority": if critical { 4 } else { 3 },
        "tags": [if critical { "rotating_light" } else { "warning" }],
    })
    .to_string()
}

pub fn send(ch: &Channel, title: &str, message: &str, critical: bool) -> Result<(), String> {
    let curl = if Path::new("/usr/bin/curl").exists() {
        "/usr/bin/curl"
    } else {
        "curl"
    };
    let mut child = Command::new(curl)
        .args([
            "-q",
            "-sS",
            "--fail",
            "--max-time",
            "5",
            "--proto",
            "=https,http",
            "-o",
            "/dev/null",
        ])
        .args([
            "-H",
            "content-type: application/json",
            "--data-binary",
            "@-",
        ])
        .arg(format!("{}/", ch.origin))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "ntfy: curl çalıştırılamadı".to_string())?;
    let body = payload(ch, title, message, critical);
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(body.as_bytes());
    }
    let st = child
        .wait()
        .map_err(|_| "ntfy: curl beklenemedi".to_string())?;
    if st.success() {
        Ok(())
    } else {
        Err(format!(
            "ntfy: yayın başarısız (curl çıkış {})",
            st.code().unwrap_or(-1)
        ))
    }
}

#[cfg(test)]
pub mod fake {
    //! Test için sahte ntfy: 127.0.0.1'de tek istek kabul eder, isteği geri verir. Canlı ntfy'a dokunulmaz.
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    pub struct Captured {
        pub request_line: String,
        pub body: String,
    }

    pub fn serve(status: u16, n: usize) -> (String, mpsc::Receiver<Captured>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = format!("http://127.0.0.1:{}", l.local_addr().unwrap().port());
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            for _ in 0..n {
                let Ok((mut s, _)) = l.accept() else { return };
                let mut r = BufReader::new(s.try_clone().unwrap());
                let mut first = String::new();
                r.read_line(&mut first).unwrap();
                let mut len = 0usize;
                loop {
                    let mut h = String::new();
                    r.read_line(&mut h).unwrap();
                    if h == "\r\n" || h.is_empty() {
                        break;
                    }
                    if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap();
                    }
                }
                let mut body = vec![0; len];
                r.read_exact(&mut body).unwrap();
                let _ = write!(
                    s,
                    "HTTP/1.1 {status} X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
                let _ = tx.send(Captured {
                    request_line: first.trim().to_string(),
                    body: String::from_utf8(body).unwrap(),
                });
            }
        });
        (addr, rx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("memwatch-ntfy-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn origin_rules_match_ts_channel() {
        assert_eq!(origin_of("https://ntfy.sh").unwrap(), "https://ntfy.sh");
        assert_eq!(origin_of("https://ntfy.sh/").unwrap(), "https://ntfy.sh");
        assert_eq!(
            origin_of("http://127.0.0.1:8080").unwrap(),
            "http://127.0.0.1:8080"
        );
        assert_eq!(origin_of("http://[::1]:9").unwrap(), "http://[::1]:9");
        assert!(origin_of("http://ntfy.sh").is_err());
        assert!(origin_of("http://localhost.evil.com").is_err());
        assert!(origin_of("https://ntfy.sh/topic").is_err());
        assert!(origin_of("https://u:p@ntfy.sh").is_err());
        assert!(origin_of("ftp://x").is_err());
        assert!(origin_of("ntfy.sh").is_err());
    }

    #[test]
    fn missing_channel_is_none_and_bad_channel_is_error() {
        let d = tmp("ch");
        assert_eq!(read_channel(&d.join("channel.json")), Ok(None));
        fs::write(d.join("bad.json"), "{").unwrap();
        assert!(read_channel(&d.join("bad.json")).is_err());
        fs::write(
            d.join("ok.json"),
            r#"{"v":1,"server":"https://ntfy.sh","requestTopic":"vlad-q-gizli","createdAt":"x"}"#,
        )
        .unwrap();
        assert_eq!(
            read_channel(&d.join("ok.json")).unwrap(),
            Some(Channel {
                origin: "https://ntfy.sh".into(),
                topic: "vlad-q-gizli".into()
            })
        );
        std::os::unix::fs::symlink(d.join("ok.json"), d.join("link.json")).unwrap();
        assert!(
            read_channel(&d.join("link.json")).is_err(),
            "sembolik bağ reddedilir"
        );
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn errors_never_echo_topic() {
        let d = tmp("echo");
        fs::write(
            d.join("c.json"),
            r#"{"v":1,"server":"http://ntfy.sh","requestTopic":"vlad-q-gizli"}"#,
        )
        .unwrap();
        let e = read_channel(&d.join("c.json")).unwrap_err();
        assert!(!e.contains("gizli"));
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn send_posts_json_to_origin_root_on_fake_server() {
        let (addr, rx) = fake::serve(200, 1);
        let ch = Channel {
            origin: addr,
            topic: "vlad-q-test".into(),
        };
        send(&ch, "VLAD bellek", "critical: boş %8", true).unwrap();
        let c = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(c.request_line.starts_with("POST / "), "{}", c.request_line);
        let v: serde_json::Value = serde_json::from_str(&c.body).unwrap();
        assert_eq!(v["topic"], "vlad-q-test");
        assert_eq!(v["title"], "VLAD bellek");
        assert_eq!(v["message"], "critical: boş %8");
        assert_eq!(v["priority"], 4);
    }

    #[test]
    fn send_reports_http_failure() {
        let (addr, _rx) = fake::serve(500, 1);
        let ch = Channel {
            origin: addr,
            topic: "vlad-q-test".into(),
        };
        let e = send(&ch, "t", "m", false).unwrap_err();
        assert!(e.contains("yayın başarısız"));
        assert!(!e.contains("vlad-q-test"));
    }
}
