//! Opt-in meeting detection: notices which other apps are using the microphone.
//! Windows: the user's microphone privacy store (app identifiers and usage timestamps).
//! macOS 14.2+: CoreAudio process objects (bundle identifier and whether input is running).
//! Never audio, and nothing leaves the device. A detection only offers a prompt; it never records.
pub use crate::domain::MicApp;
use std::collections::{BTreeMap, BTreeSet};

/// How often the system is asked while detection is on.
pub const POLL: std::time::Duration = std::time::Duration::from_secs(3);

/// Windows store key to a name: "Chrome" for `C:#…#chrome.exe`; "WhatsAppDesktop" for
/// `5319275A.WhatsAppDesktop_cv1g1gvanyjgm`.
pub fn display_name(id: &str) -> String {
    let name = match id.rsplit_once('#') {
        Some((_, file)) => {
            let lower = file.to_ascii_lowercase();
            if lower.ends_with(".exe") {
                &file[..file.len() - 4]
            } else {
                file
            }
        }
        None => {
            let family = id.rsplit_once('_').map_or(id, |(family, _)| family);
            family.rsplit_once('.').map_or(family, |(_, name)| name)
        }
    };
    let mut chars = name.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_else(|| id.to_string())
}

/// macOS: the outermost app bundle in an executable path, so a browser's helper process is named
/// after the browser: "Google Chrome" for `/Applications/Google Chrome.app/Contents/…/Helper`.
#[cfg(any(target_os = "macos", test))]
pub fn app_name_from_path(path: &str) -> Option<String> {
    path.split('/')
        .find_map(|part| part.strip_suffix(".app"))
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

/// Windows sets `LastUsedTimeStop` below `LastUsedTimeStart` (or to 0) while an app holds the mic.
pub fn in_use(start: u64, stop: u64) -> bool {
    start > stop
}

/// Reports an app only after two consecutive polls, so a brief microphone check does not prompt,
/// and reports the list only when it changes.
#[derive(Default)]
pub struct Debounce {
    previous: BTreeSet<String>,
    reported: Option<BTreeSet<String>>,
}

impl Debounce {
    pub fn update(&mut self, now: BTreeSet<String>) -> Option<Vec<String>> {
        let stable: BTreeSet<String> = now.intersection(&self.previous).cloned().collect();
        self.previous = now;
        if self.reported.as_ref() == Some(&stable) {
            return None;
        }
        self.reported = Some(stable.clone());
        Some(stable.into_iter().collect())
    }
}

/// Windows, or the same macOS versions that can record (Apple Silicon on 14.2 or newer).
pub fn supported() -> bool {
    cfg!(windows) || (cfg!(target_os = "macos") && crate::capture_gate::supported())
}

/// Apps currently holding the microphone, except this app, as id to display name.
/// Empty when unsupported or unreadable.
#[cfg(windows)]
pub fn poll() -> BTreeMap<String, String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let own = std::env::current_exe().ok().and_then(|path| {
        path.file_name()
            .map(|name| name.to_string_lossy().to_lowercase())
    });
    let mut found = BTreeMap::new();
    let Ok(root) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(
        r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone",
    ) else {
        return found;
    };
    let mut check = |parent: &RegKey, name: String| {
        let Ok(key) = parent.open_subkey(&name) else {
            return;
        };
        let start: u64 = key.get_value("LastUsedTimeStart").unwrap_or(0);
        let stop: u64 = key.get_value("LastUsedTimeStop").unwrap_or(0);
        let file = name.rsplit('#').next().unwrap_or(&name).to_lowercase();
        if in_use(start, stop) && own.as_deref() != Some(file.as_str()) {
            found.insert(name.clone(), display_name(&name));
        }
    };
    for name in root.enum_keys().flatten() {
        if name == "NonPackaged" {
            if let Ok(desktop) = root.open_subkey(&name) {
                for app in desktop.enum_keys().flatten() {
                    check(&desktop, app);
                }
            }
        } else {
            check(&root, name);
        }
    }
    found
}

/// Processes CoreAudio reports as running input, keyed by bundle identifier. Processes without a
/// bundle identifier (command-line tools) are not reported.
#[cfg(target_os = "macos")]
pub fn poll() -> BTreeMap<String, String> {
    use std::ffi::{c_char, c_int, c_void, CStr};

    #[repr(C)]
    struct Address {
        selector: u32,
        scope: u32,
        element: u32,
    }
    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectGetPropertyDataSize(
            object: u32,
            address: *const Address,
            qualifier_size: u32,
            qualifier: *const c_void,
            size: *mut u32,
        ) -> i32;
        fn AudioObjectGetPropertyData(
            object: u32,
            address: *const Address,
            qualifier_size: u32,
            qualifier: *const c_void,
            size: *mut u32,
            data: *mut c_void,
        ) -> i32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringGetCString(
            string: *const c_void,
            buffer: *mut c_char,
            size: isize,
            encoding: u32,
        ) -> u8;
        fn CFRelease(object: *const c_void);
    }
    extern "C" {
        fn proc_pidpath(pid: c_int, buffer: *mut c_void, size: u32) -> c_int;
    }
    const SYSTEM_OBJECT: u32 = 1;
    const UTF8: u32 = 0x0800_0100;
    let address = |selector: &[u8; 4]| Address {
        selector: u32::from_be_bytes(*selector),
        scope: u32::from_be_bytes(*b"glob"),
        element: 0,
    };
    /// Reads one fixed-size property; None when the call fails or returns another size.
    unsafe fn read<T: Copy>(object: u32, address: &Address) -> Option<T> {
        let mut value = std::mem::MaybeUninit::<T>::zeroed();
        let mut size = std::mem::size_of::<T>() as u32;
        let status = AudioObjectGetPropertyData(
            object,
            address,
            0,
            std::ptr::null(),
            &mut size,
            value.as_mut_ptr().cast(),
        );
        (status == 0 && size as usize == std::mem::size_of::<T>()).then(|| value.assume_init())
    }

    let mut found = BTreeMap::new();
    let own = std::process::id() as i32;
    unsafe {
        let list = address(b"prs#");
        let mut size = 0u32;
        if AudioObjectGetPropertyDataSize(SYSTEM_OBJECT, &list, 0, std::ptr::null(), &mut size) != 0
        {
            return found;
        }
        let mut processes = vec![0u32; size as usize / std::mem::size_of::<u32>()];
        if AudioObjectGetPropertyData(
            SYSTEM_OBJECT,
            &list,
            0,
            std::ptr::null(),
            &mut size,
            processes.as_mut_ptr().cast(),
        ) != 0
        {
            return found;
        }
        processes.truncate(size as usize / std::mem::size_of::<u32>());
        for process in processes {
            if read::<u32>(process, &address(b"piri")) != Some(1) {
                continue;
            }
            let Some(pid) = read::<i32>(process, &address(b"ppid")) else {
                continue;
            };
            if pid == own {
                continue;
            }
            let Some(bundle) = read::<*const c_void>(process, &address(b"pbid")) else {
                continue;
            };
            if bundle.is_null() {
                continue;
            }
            let mut buffer = [0 as c_char; 512];
            let copied =
                CFStringGetCString(bundle, buffer.as_mut_ptr(), buffer.len() as isize, UTF8);
            CFRelease(bundle);
            if copied == 0 {
                continue;
            }
            let id = CStr::from_ptr(buffer.as_ptr())
                .to_string_lossy()
                .into_owned();
            if id.is_empty() {
                continue;
            }
            let mut path = [0u8; 4096];
            let length = proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32);
            let name = (length > 0)
                .then(|| String::from_utf8_lossy(&path[..length as usize]).into_owned())
                .and_then(|path| app_name_from_path(&path))
                .unwrap_or_else(|| id.rsplit('.').next().unwrap_or(&id).to_string());
            found.insert(id, name);
        }
    }
    found
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn poll() -> BTreeMap<String, String> {
    BTreeMap::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(items: &[&str]) -> BTreeSet<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn names_desktop_and_packaged_apps() {
        assert_eq!(
            display_name("C:#Program Files#Google#Chrome#Application#chrome.exe"),
            "Chrome"
        );
        assert_eq!(display_name("C:#Apps#Zoom.EXE"), "Zoom");
        assert_eq!(
            display_name("5319275A.WhatsAppDesktop_cv1g1gvanyjgm"),
            "WhatsAppDesktop"
        );
        assert_eq!(display_name("MSTeams_8wekyb3d8bbwe"), "MSTeams");
        assert_eq!(
            display_name("Microsoft.WindowsCamera_8wekyb3d8bbwe"),
            "WindowsCamera"
        );
    }

    #[test]
    fn names_mac_apps_after_their_outermost_bundle() {
        assert_eq!(
            app_name_from_path("/Applications/zoom.us.app/Contents/MacOS/zoom.us").as_deref(),
            Some("zoom.us")
        );
        assert_eq!(
            app_name_from_path(
                "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper"
            )
            .as_deref(),
            Some("Google Chrome")
        );
        assert_eq!(app_name_from_path("/usr/bin/say"), None);
        assert_eq!(app_name_from_path("/tmp/.app/x"), None);
    }

    #[test]
    fn in_use_only_while_start_is_after_stop() {
        assert!(in_use(5, 0));
        assert!(in_use(9, 4));
        assert!(!in_use(4, 9));
        assert!(!in_use(0, 0));
    }

    #[test]
    fn reports_apps_after_two_polls_and_only_changes() {
        let mut debounce = Debounce::default();
        // The first report is the empty starting state.
        assert_eq!(debounce.update(set(&["zoom"])), Some(vec![]));
        assert_eq!(debounce.update(set(&["zoom"])), Some(vec!["zoom".into()]));
        assert_eq!(debounce.update(set(&["zoom"])), None);
        // A single-poll blip from another app is not reported.
        assert_eq!(debounce.update(set(&["zoom", "dictation"])), None);
        assert_eq!(debounce.update(set(&["zoom"])), None);
        assert_eq!(debounce.update(set(&[])), Some(vec![]));
        assert_eq!(debounce.update(set(&[])), None);
    }
}
