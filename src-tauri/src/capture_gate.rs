//! Platform gate for real capture. Windows stays as it was. macOS uses the
//! pinned cpal process tap only for Apple Silicon on 14.2 or newer, and only
//! for an output device that has no input of its own.
use crate::domain::{AppError, Result};

const TAP_FLOOR: (u32, u32) = (14, 2);
const PREFLIGHT_GRANTED: i32 = 0;

pub fn supported() -> bool {
    if cfg!(target_os = "windows") {
        return true;
    }
    cfg!(all(target_os = "macos", target_arch = "aarch64")) && macos_version_ok()
}

pub fn unsupported_reason() -> AppError {
    audio_error(
        "Real capture needs Windows, or Apple Silicon on macOS 14.2 or newer. Intel Macs and older macOS are not supported.",
    )
}

/// macOS only. An output that also supports input is not a system tap.
pub fn reject_duplex_output(supports_input: bool) -> Result<()> {
    if supports_input {
        Err(audio_error(
            "This system output also has an input, so macOS would record that input as Others. Choose an output-only device such as the speakers.",
        ))
    } else {
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub fn ensure_permissions() -> Result<()> {
    let mic = tcc_preflight("kTCCServiceMicrophone")?;
    let system = tcc_preflight("kTCCServiceAudioCapture")?;
    if let Some(message) = missing_permission_message(mic, system) {
        return Err(audio_error(message));
    }
    Ok(())
}

pub fn os_meets_tap_floor(version: &str) -> bool {
    let mut parts = version.trim().split('.');
    let Some(major) = parts.next().and_then(|part| part.parse::<u32>().ok()) else {
        return false;
    };
    let minor = parts
        .next()
        .and_then(|part| part.parse::<u32>().ok())
        .unwrap_or(0);
    (major, minor) >= TAP_FLOOR
}

pub fn missing_permission_message(mic: i32, system: i32) -> Option<&'static str> {
    match (mic == PREFLIGHT_GRANTED, system == PREFLIGHT_GRANTED) {
        (true, true) => None,
        (false, false) => Some(
            "Microphone and System Audio Recording permission are missing. Grant both to target/debug/openmeet in System Settings > Privacy & Security. A rebuild can drop the grant. This preview has no installer. Permission denial has not been hardware-tested.",
        ),
        (false, true) => Some(
            "Microphone permission is missing. Grant it to target/debug/openmeet in System Settings > Privacy & Security. A rebuild can drop the grant. This preview has no installer. Permission denial has not been hardware-tested.",
        ),
        (true, false) => Some(
            "System Audio Recording permission is missing. A missing grant can open the stream and write silence, so capture was not started. Grant it to target/debug/openmeet in System Settings > Privacy & Security. A rebuild can drop the grant. This preview has no installer. Permission denial has not been hardware-tested.",
        ),
    }
}

fn macos_version_ok() -> bool {
    product_version().is_some_and(|version| os_meets_tap_floor(&version))
}

fn product_version() -> Option<String> {
    let text = std::fs::read_to_string("/System/Library/CoreServices/SystemVersion.plist").ok()?;
    let key = "<key>ProductVersion</key>";
    let rest = text.get(text.find(key)? + key.len()..)?;
    let start = rest.find("<string>")? + "<string>".len();
    let end = start + rest[start..].find("</string>")?;
    let version = rest[start..end].trim();
    if version.is_empty() {
        None
    } else {
        Some(version.to_string())
    }
}

fn audio_error(message: impl Into<String>) -> AppError {
    AppError::new("audio", message)
}

#[cfg(target_os = "macos")]
fn tcc_preflight(service_symbol: &str) -> Result<i32> {
    use std::ffi::{CStr, CString};
    use std::os::raw::{c_char, c_int, c_void};

    #[link(name = "System")]
    extern "C" {
        fn dlopen(path: *const c_char, flags: c_int) -> *mut c_void;
        fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
        fn dlerror() -> *mut c_char;
    }
    const RTLD_NOW: c_int = 2;

    unsafe {
        let path = CString::new("/System/Library/PrivateFrameworks/TCC.framework/TCC")
            .map_err(|_| audio_error("Could not check capture permission."))?;
        let handle = dlopen(path.as_ptr(), RTLD_NOW);
        if handle.is_null() {
            let detail = dlerror();
            let detail = if detail.is_null() {
                "TCC could not be opened".to_string()
            } else {
                CStr::from_ptr(detail).to_string_lossy().into_owned()
            };
            return Err(audio_error(format!(
                "Could not check capture permission ({detail}). Capture was not started. Grant Microphone and System Audio Recording to target/debug/openmeet. A rebuild can drop the grant."
            )));
        }
        let preflight = dlsym(handle, c"TCCAccessPreflight".as_ptr());
        let service_name = CString::new(service_symbol)
            .map_err(|_| audio_error("Could not check capture permission."))?;
        let service_sym = dlsym(handle, service_name.as_ptr());
        if preflight.is_null() || service_sym.is_null() {
            return Err(audio_error(
                "Could not check capture permission. Capture was not started. Grant Microphone and System Audio Recording to target/debug/openmeet. A rebuild can drop the grant.",
            ));
        }
        let service = *(service_sym as *const *const c_void);
        let func: unsafe extern "C" fn(*const c_void, *const c_void) -> c_int =
            std::mem::transmute(preflight);
        Ok(func(service, std::ptr::null()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tap_floor_is_14_2_and_rejects_junk() {
        assert!(!os_meets_tap_floor(""));
        assert!(!os_meets_tap_floor("foo"));
        assert!(!os_meets_tap_floor("14"));
        assert!(!os_meets_tap_floor("14.1"));
        assert!(!os_meets_tap_floor("14.1.9"));
        assert!(os_meets_tap_floor("14.2"));
        assert!(os_meets_tap_floor("14.2.1"));
        assert!(os_meets_tap_floor("15.0"));
        assert!(os_meets_tap_floor("27.0.1"));
    }

    #[test]
    fn permission_messages_name_the_debug_binary_and_pass_only_on_grant() {
        assert!(missing_permission_message(0, 0).is_none());
        let both = missing_permission_message(1, 1).unwrap();
        assert!(both.contains("Microphone and System Audio Recording"));
        assert!(both.contains("target/debug/openmeet"));
        assert!(missing_permission_message(1, 0)
            .unwrap()
            .contains("Microphone permission"));
        assert!(missing_permission_message(0, 2)
            .unwrap()
            .contains("System Audio Recording"));
    }

    #[test]
    fn duplex_output_is_refused_and_output_only_is_not() {
        assert!(reject_duplex_output(true).is_err());
        assert!(reject_duplex_output(false).is_ok());
    }
}
