//! Opt-in meeting detection: notices which apps Windows reports as using the microphone.
//! It reads app identifiers and usage timestamps from the user's microphone privacy store, never
//! audio, and nothing leaves the device. A detection only offers a prompt; it never starts recording.
use serde::Serialize;
use std::collections::BTreeSet;

/// How often the privacy store is read while detection is on.
pub const POLL: std::time::Duration = std::time::Duration::from_secs(3);

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct MicApp {
    /// The store's key: a package family name, or a desktop app path with `#` for `\`.
    pub id: String,
    pub name: String,
}

/// "Chrome" for `C:#…#chrome.exe`; "WhatsAppDesktop" for `5319275A.WhatsAppDesktop_cv1g1gvanyjgm`.
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

pub const SUPPORTED: bool = cfg!(windows);

/// Apps currently holding the microphone, except this app. Empty when unsupported or unreadable.
#[cfg(windows)]
pub fn poll() -> BTreeSet<String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let own = std::env::current_exe().ok().and_then(|path| {
        path.file_name()
            .map(|name| name.to_string_lossy().to_lowercase())
    });
    let mut found = BTreeSet::new();
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
            found.insert(name);
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

#[cfg(not(windows))]
pub fn poll() -> BTreeSet<String> {
    BTreeSet::new()
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
