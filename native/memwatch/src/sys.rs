//! Sistem ölçümü. Tek güvensiz (FFI) bölge burasıdır; dışarıya yalnız güvenli işlevler açılır.
//! macOS: `sysctlbyname` (kern.memorystatus_level = memory_pressure'ın boş yüzdesi, kern.memorystatus_vm_pressure_level,
//! vm.swapusage, hw.memsize), `proc_listallpids` + `proc_pidinfo(PROC_PIDTBSDINFO)` (ppid, ad),
//! `proc_pid_rusage(RUSAGE_INFO_V2).ri_phys_footprint` (Etkinlik İzleyicisi'nin "Bellek" sütunu).
use crate::model::SystemStats;
use crate::tree::Proc;
use std::io;

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use crate::model::Pressure;
    use std::ffi::CString;
    use std::mem::{size_of, MaybeUninit};

    fn sysctl_raw<T: Copy>(name: &str) -> io::Result<T> {
        let c = CString::new(name).map_err(|_| io::Error::other("sysctl adı"))?;
        let mut v = MaybeUninit::<T>::zeroed();
        let mut len = size_of::<T>();
        // SAFETY: v, T boyutunda yazılabilir bellek; len o boyutla başlar ve çekirdek en çok len bayt yazar.
        let r = unsafe {
            libc::sysctlbyname(
                c.as_ptr(),
                v.as_mut_ptr().cast(),
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        };
        if r != 0 {
            return Err(io::Error::last_os_error());
        }
        if len != size_of::<T>() {
            return Err(io::Error::other(format!(
                "sysctl {name}: beklenmeyen boyut {len}"
            )));
        }
        // SAFETY: çekirdek tam size_of::<T>() bayt yazdı (yukarıda denetlendi); T düz veri (Copy, POD).
        Ok(unsafe { v.assume_init() })
    }

    pub fn system() -> io::Result<SystemStats> {
        let total: u64 = sysctl_raw("hw.memsize")?;
        let free: i32 = sysctl_raw("kern.memorystatus_level")?;
        let pressure: i32 = sysctl_raw("kern.memorystatus_vm_pressure_level")?;
        let swap: libc::xsw_usage = sysctl_raw("vm.swapusage")?;
        Ok(SystemStats {
            total_bytes: total,
            free_pct: free.clamp(0, 100) as u32,
            pressure: Pressure::from_raw(pressure.max(0) as u32),
            swap_total_bytes: swap.xsu_total,
            swap_used_bytes: swap.xsu_used,
        })
    }

    fn all_pids() -> Vec<i32> {
        // SAFETY: boş tampon + 0 boyut: yalnız süreç sayısını döner.
        let n = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
        if n <= 0 {
            return Vec::new();
        }
        let cap = n as usize + 64; // ölçüm arasında doğan süreçler için pay
        let mut buf = vec![0i32; cap];
        // SAFETY: buf cap adet i32 için yazılabilir; boyut bayt cinsinden verilir.
        let got = unsafe {
            libc::proc_listallpids(buf.as_mut_ptr().cast(), (cap * size_of::<i32>()) as i32)
        };
        if got <= 0 {
            return Vec::new();
        }
        buf.truncate((got as usize).min(cap));
        buf.retain(|&p| p > 0);
        buf
    }

    fn cstr(b: &[libc::c_char]) -> String {
        let bytes: Vec<u8> = b
            .iter()
            .take_while(|&&c| c != 0)
            .map(|&c| c as u8)
            .collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    fn bsd_info(pid: i32) -> Option<(i32, String)> {
        let mut info = MaybeUninit::<libc::proc_bsdinfo>::zeroed();
        let sz = size_of::<libc::proc_bsdinfo>() as i32;
        // SAFETY: info, proc_bsdinfo boyutunda yazılabilir; çekirdek en çok sz bayt yazar.
        let r = unsafe {
            libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, info.as_mut_ptr().cast(), sz)
        };
        if r != sz {
            return None; // süreç bitti ya da erişim yok
        }
        // SAFETY: tam sz bayt yazıldı (yukarıda denetlendi).
        let info = unsafe { info.assume_init() };
        let name = cstr(&info.pbi_name);
        let name = if name.is_empty() {
            cstr(&info.pbi_comm)
        } else {
            name
        };
        let name = if crate::tree::is_version_like(&name) {
            crate::tree::display_name(&name, pid_path(pid).as_deref())
        } else {
            name
        };
        Some((info.pbi_ppid as i32, name))
    }

    fn pid_path(pid: i32) -> Option<String> {
        let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        // SAFETY: buf, verilen boyutta yazılabilir; dönüş yazılan bayt sayısıdır.
        let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
        if n <= 0 {
            return None;
        }
        buf.truncate(n as usize);
        String::from_utf8(buf).ok()
    }

    fn footprint(pid: i32) -> Option<u64> {
        let mut ri = MaybeUninit::<libc::rusage_info_v2>::zeroed();
        // SAFETY: proc_pid_rusage, flavor V2 için rusage_info_v2 boyutunda tampon yazar; libc imzası tamponu
        // `*mut rusage_info_t` olarak bildirir (C'deki void* kalıbı), işaretçi tamponun kendisidir.
        let r = unsafe { libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V2, ri.as_mut_ptr().cast()) };
        if r != 0 {
            return None;
        }
        // SAFETY: başarılı çağrı tüm yapıyı doldurur.
        Some(unsafe { ri.assume_init() }.ri_phys_footprint)
    }

    pub fn procs() -> Vec<Proc> {
        all_pids()
            .into_iter()
            .filter_map(|pid| {
                let (ppid, name) = bsd_info(pid)?;
                Some(Proc {
                    pid,
                    ppid,
                    name,
                    footprint: footprint(pid).unwrap_or(0),
                })
            })
            .collect()
    }

    /// Bu sürecin kendi RSS'i (daemon < 10 MB hedefinin ölçümü; durum dosyasına yazılır).
    pub fn self_rss() -> u64 {
        let mut ri = MaybeUninit::<libc::rusage_info_v2>::zeroed();
        // SAFETY: yukarıdaki footprint ile aynı sözleşme; getpid her zaman geçerli.
        let r = unsafe {
            libc::proc_pid_rusage(libc::getpid(), libc::RUSAGE_INFO_V2, ri.as_mut_ptr().cast())
        };
        if r != 0 {
            return 0;
        }
        // SAFETY: başarılı çağrı yapıyı doldurur.
        unsafe { ri.assume_init() }.ri_resident_size
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::*;
    pub fn system() -> io::Result<SystemStats> {
        Err(io::Error::other("memwatch yalnız macOS'ta ölçer"))
    }
    pub fn procs() -> Vec<Proc> {
        Vec::new()
    }
    pub fn self_rss() -> u64 {
        0
    }
}

pub use imp::{procs, self_rss, system};

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn system_reads_plausible_values() {
        let s = system().expect("sysctl");
        assert!(s.total_bytes >= 1 << 30);
        assert!(s.free_pct <= 100);
        assert!(s.swap_used_bytes <= s.swap_total_bytes || s.swap_total_bytes == 0);
    }

    #[test]
    fn procs_contains_self_with_footprint() {
        let me = std::process::id() as i32;
        let all = procs();
        let p = all
            .iter()
            .find(|p| p.pid == me)
            .expect("kendi süreci listede");
        assert!(p.footprint > 0);
        assert!(!p.name.is_empty());
        assert!(self_rss() > 0);
    }
}
