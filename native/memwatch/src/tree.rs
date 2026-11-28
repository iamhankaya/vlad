//! Süreç tablosunu satırlara gruplar (saf; sistem çağrısı yok):
//! - `task`: tmux oturumu `vlad-<görev-id>` panellerinin süreç ağacı (claude + cargo/rustc/node/docker CLI …)
//! - `vlad`: ana VLAD tmux oturumu (`vlad`)
//! - `vm`: colima / Virtualization.framework / qemu süreçleri
//! - `terminal`: Terminal.app ve (tmux'a ait olmayan) alt süreçleri
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Clone, Debug, PartialEq)]
pub struct Proc {
    pub pid: i32,
    pub ppid: i32,
    pub name: String,
    pub footprint: u64,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Task,
    Vlad,
    Vm,
    Terminal,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct TopProc {
    pub pid: i32,
    pub name: String,
    pub footprint_bytes: u64,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Group {
    /// görev kimliği (`T20261128-06`), `vlad`, `vm` ya da `terminal`
    pub id: String,
    pub kind: Kind,
    pub footprint_bytes: u64,
    pub procs: usize,
    pub top: Option<TopProc>,
}

pub fn is_version_like(name: &str) -> bool {
    name.contains('.') && name.chars().all(|c| c.is_ascii_digit() || c == '.')
}

/// Sürüm numarasıyla adlanan ikililer (`…/claude/versions/2.1.332`) için ürün dizininin adı; aksi halde süreç adı.
pub fn display_name(name: &str, path: Option<&str>) -> String {
    if is_version_like(name) {
        if let Some(prod) = path.and_then(|p| {
            let mut it = p.rsplit('/');
            let _file = it.next()?;
            (it.next()? == "versions").then(|| it.next())?
        }) {
            if !prod.is_empty() {
                return prod.to_string();
            }
        }
    }
    name.to_string()
}

/// tmux `#{session_name} #{pane_pid}` satırları.
pub fn parse_tmux_panes(out: &str) -> Vec<(String, i32)> {
    out.lines()
        .filter_map(|l| {
            let (s, p) = l.trim().rsplit_once(' ')?;
            Some((s.to_string(), p.parse().ok()?))
        })
        .collect()
}

fn session_kind(name: &str) -> Option<(Kind, String)> {
    if name == "vlad" {
        return Some((Kind::Vlad, "vlad".into()));
    }
    let id = name.strip_prefix("vlad-")?;
    if !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        Some((Kind::Task, id.to_string()))
    } else {
        None
    }
}

fn is_vm(name: &str) -> bool {
    // proc_bsdinfo.pbi_name 32 bayta kırpılır: "com.apple.Virtualization.VirtualMachine" öneki yeter
    name.starts_with("com.apple.Virtualization.Virtu")
        || name.starts_with("qemu-system")
        || name == "limactl"
        || name == "colima"
        || name == "vfkit"
}

fn descendants(
    roots: &[i32],
    children: &HashMap<i32, Vec<i32>>,
    claimed: &mut HashSet<i32>,
) -> Vec<i32> {
    let mut out = Vec::new();
    let mut stack: Vec<i32> = roots.to_vec();
    while let Some(p) = stack.pop() {
        if !claimed.insert(p) {
            continue; // döngü ya da başka gruba ait
        }
        out.push(p);
        if let Some(c) = children.get(&p) {
            stack.extend(c.iter().copied());
        }
    }
    out
}

fn make_group(id: String, kind: Kind, pids: &[i32], by_pid: &HashMap<i32, &Proc>) -> Group {
    let members: Vec<&Proc> = pids.iter().filter_map(|p| by_pid.get(p).copied()).collect();
    let top = members
        .iter()
        .max_by_key(|p| (p.footprint, -p.pid))
        .map(|p| TopProc {
            pid: p.pid,
            name: p.name.clone(),
            footprint_bytes: p.footprint,
        });
    Group {
        id,
        kind,
        footprint_bytes: members.iter().map(|p| p.footprint).sum(),
        procs: members.len(),
        top,
    }
}

/// Satırlar: görevler (kimliğe göre sıralı), `vlad`, `vm`, `terminal`; boş vm/terminal satırı yazılmaz.
pub fn group(procs: &[Proc], panes: &[(String, i32)]) -> Vec<Group> {
    let by_pid: HashMap<i32, &Proc> = procs.iter().map(|p| (p.pid, p)).collect();
    let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
    for p in procs {
        if p.ppid != p.pid {
            children.entry(p.ppid).or_default().push(p.pid);
        }
    }
    let mut sessions: BTreeMap<(u8, String), (Kind, Vec<i32>)> = BTreeMap::new();
    for (name, pid) in panes {
        if let Some((kind, id)) = session_kind(name) {
            let order = if kind == Kind::Task { 0 } else { 1 };
            sessions
                .entry((order, id))
                .or_insert((kind, Vec::new()))
                .1
                .push(*pid);
        }
    }
    let mut claimed = HashSet::new();
    let mut out = Vec::new();
    for ((_, id), (kind, roots)) in sessions {
        let pids = descendants(&roots, &children, &mut claimed);
        out.push(make_group(id, kind, &pids, &by_pid));
    }
    let vm_roots: Vec<i32> = procs
        .iter()
        .filter(|p| is_vm(&p.name) && !claimed.contains(&p.pid))
        .map(|p| p.pid)
        .collect();
    let vm = descendants(&vm_roots, &children, &mut claimed);
    if !vm.is_empty() {
        out.push(make_group("vm".into(), Kind::Vm, &vm, &by_pid));
    }
    let term_roots: Vec<i32> = procs
        .iter()
        .filter(|p| p.name == "Terminal" && !claimed.contains(&p.pid))
        .map(|p| p.pid)
        .collect();
    let term = descendants(&term_roots, &children, &mut claimed);
    if !term.is_empty() {
        out.push(make_group(
            "terminal".into(),
            Kind::Terminal,
            &term,
            &by_pid,
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(pid: i32, ppid: i32, name: &str, mb: u64) -> Proc {
        Proc {
            pid,
            ppid,
            name: name.into(),
            footprint: mb << 20,
        }
    }

    #[test]
    fn version_named_binary_takes_product_dir_name() {
        // claude ikilisi ~/.local/share/claude/versions/2.1.332: p_comm sürüm numarasıdır
        assert!(is_version_like("2.1.332"));
        assert!(!is_version_like("rustc"));
        assert!(!is_version_like(""));
        assert_eq!(
            display_name(
                "2.1.332",
                Some("/Users/u/.local/share/claude/versions/2.1.332")
            ),
            "claude"
        );
        assert_eq!(display_name("2.1.332", Some("/opt/x/2.1.332")), "2.1.332");
        assert_eq!(display_name("2.1.332", None), "2.1.332");
        assert_eq!(display_name("node", Some("/a/versions/node")), "node");
    }

    #[test]
    fn parses_tmux_lines_and_skips_garbage() {
        let v = parse_tmux_panes("vlad 100\nvlad-T20261128-06 200\nbozuk\nx abc\n");
        assert_eq!(
            v,
            vec![("vlad".into(), 100), ("vlad-T20261128-06".into(), 200)]
        );
    }

    #[test]
    fn task_tree_sums_descendants_and_picks_top() {
        let procs = [
            p(1, 0, "launchd", 10),
            p(200, 1, "zsh", 5),
            p(201, 200, "claude", 400),
            p(202, 201, "cargo", 50),
            p(203, 202, "rustc", 900),
            p(300, 1, "Safari", 2000),
        ];
        let g = group(&procs, &[("vlad-T1".into(), 200)]);
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].id, "T1");
        assert_eq!(g[0].kind, Kind::Task);
        assert_eq!(g[0].procs, 4);
        assert_eq!(g[0].footprint_bytes, (5 + 400 + 50 + 900) << 20);
        assert_eq!(g[0].top.as_ref().unwrap().name, "rustc");
    }

    #[test]
    fn non_vlad_sessions_ignored_and_main_session_is_vlad_row() {
        let procs = [p(10, 1, "zsh", 1), p(20, 1, "zsh", 2), p(30, 1, "zsh", 3)];
        let g = group(
            &procs,
            &[
                ("work".into(), 10),
                ("vlad".into(), 20),
                ("vlad-".into(), 30),
            ],
        );
        assert_eq!(g.len(), 1);
        assert_eq!((g[0].id.as_str(), g[0].kind), ("vlad", Kind::Vlad));
    }

    #[test]
    fn tasks_sorted_before_vlad_and_multi_pane_merged() {
        let procs = [
            p(10, 1, "zsh", 1),
            p(11, 1, "zsh", 1),
            p(20, 1, "zsh", 2),
            p(30, 1, "zsh", 3),
        ];
        let panes = [
            ("vlad".into(), 30),
            ("vlad-T2".into(), 20),
            ("vlad-T1".into(), 10),
            ("vlad-T1".into(), 11),
        ];
        let g = group(&procs, &panes);
        let ids: Vec<&str> = g.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(ids, ["T1", "T2", "vlad"]);
        assert_eq!(g[0].procs, 2);
    }

    #[test]
    fn vm_and_terminal_rows_exclude_tmux_claimed() {
        let procs = [
            p(50, 1, "com.apple.Virtualization.Virtua", 3000),
            p(51, 1, "limactl", 30),
            p(60, 1, "Terminal", 200),
            p(61, 60, "login", 1),
            p(62, 61, "zsh", 2),
            p(63, 62, "tmux", 4), // tmux istemcisi: Terminal'de kalır
            p(70, 1, "zsh", 3),   // tmux paneli (sunucu launchd'nin çocuğu)
        ];
        let g = group(&procs, &[("vlad-T1".into(), 70)]);
        let vm = g.iter().find(|x| x.kind == Kind::Vm).unwrap();
        assert_eq!(vm.footprint_bytes, 3030 << 20);
        let t = g.iter().find(|x| x.kind == Kind::Terminal).unwrap();
        assert_eq!(t.procs, 4);
        assert_eq!(g[0].procs, 1);
    }

    #[test]
    fn ppid_cycle_does_not_loop() {
        let procs = [p(5, 6, "a", 1), p(6, 5, "b", 1)];
        let g = group(&procs, &[("vlad-T".into(), 5)]);
        assert_eq!(g[0].procs, 2);
    }

    #[test]
    fn missing_pane_pid_gives_empty_row() {
        let g = group(&[], &[("vlad-T9".into(), 999)]);
        assert_eq!(
            (g[0].procs, g[0].footprint_bytes, g[0].top.clone()),
            (0, 0, None)
        );
    }
}
