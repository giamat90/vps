//! Which pitch-detection algorithm the app runs.
//!
//! End users do not choose it. It is decided by our own A/B experiments
//! (`sidecar/pitch_lab`), and `DEFAULT` is what ships. To try another algorithm in
//! the real app, set `VPS_PITCH_ALGORITHM` before launching it: an unknown value
//! is an error, never a silent fallback, because a mistyped experiment that quietly
//! ran SRH would look like a result.

use std::env::VarError;

pub const DEFAULT: &str = "srh";
pub const OVERRIDE_ENV: &str = "VPS_PITCH_ALGORITHM";

/// Must stay equal to the sidecar's `PITCH_ALGORITHMS` minus `piano`
/// (asserted from `sidecar/tests/test_pitch.py`).
pub const EXPERIMENTAL: [&str; 5] = ["srh", "praat", "pyin", "hps", "crepe"];

const INSTRUMENT: &str = "piano";

pub fn resolve(override_value: Option<&str>) -> Result<String, String> {
    let requested = override_value.map(str::trim).filter(|v| !v.is_empty());
    match requested {
        None => Ok(DEFAULT.to_string()),
        Some(name) if EXPERIMENTAL.contains(&name) => Ok(name.to_string()),
        Some(name) => Err(format!(
            "{OVERRIDE_ENV}={name:?} is not a pitch algorithm; use one of: {}",
            EXPERIMENTAL.join(", ")
        )),
    }
}

fn from_env(var: Result<String, VarError>) -> Result<String, String> {
    match var {
        Ok(value) => resolve(Some(&value)),
        Err(VarError::NotPresent) => resolve(None),
        Err(VarError::NotUnicode(raw)) => Err(format!("{OVERRIDE_ENV} is not valid text: {raw:?}")),
    }
}

/// The algorithm for vocals, recorded takes and imported exercise files.
pub fn vocal() -> Result<String, String> {
    from_env(std::env::var(OVERRIDE_ENV))
}

/// Instrument practice tracks (a piano scale the singer pitches against) need a
/// monophonic-instrument detector, not the voice-tuned one; takes recorded
/// against them still use `vocal()`.
pub fn for_track(skip_separation: bool) -> Result<String, String> {
    if skip_separation {
        Ok(INSTRUMENT.to_string())
    } else {
        vocal()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ships_srh() {
        assert_eq!(DEFAULT, "srh");
        assert_eq!(resolve(None).unwrap(), "srh");
    }

    #[test]
    fn an_empty_or_blank_override_means_not_set() {
        assert_eq!(resolve(Some("")).unwrap(), "srh");
        assert_eq!(resolve(Some("   ")).unwrap(), "srh");
    }

    #[test]
    fn every_experimental_algorithm_can_be_selected() {
        for name in EXPERIMENTAL {
            assert_eq!(resolve(Some(name)).unwrap(), name);
        }
    }

    #[test]
    fn surrounding_whitespace_is_ignored() {
        assert_eq!(resolve(Some("  crepe\n")).unwrap(), "crepe");
    }

    #[test]
    fn an_unknown_override_is_an_error_not_a_silent_fallback() {
        for bad in ["SRH", "yin", "piano", "srh,praat"] {
            let err = resolve(Some(bad)).unwrap_err();
            assert!(err.contains(OVERRIDE_ENV), "{err}");
            assert!(err.contains(&format!("{bad:?}")), "names the rejected value: {err}");
            for name in EXPERIMENTAL {
                assert!(err.contains(name), "lists {name}: {err}");
            }
        }
    }

    #[test]
    fn the_environment_variable_feeds_the_resolver() {
        assert_eq!(from_env(Err(VarError::NotPresent)).unwrap(), "srh");
        assert_eq!(from_env(Ok("hps".into())).unwrap(), "hps");
        assert!(from_env(Ok("nope".into())).is_err());
    }

    #[test]
    fn a_non_unicode_value_is_an_error_not_treated_as_unset() {
        #[cfg(windows)]
        let raw = {
            use std::os::windows::ffi::OsStringExt;
            std::ffi::OsString::from_wide(&[0xD800])
        };
        #[cfg(not(windows))]
        let raw = {
            use std::os::unix::ffi::OsStringExt;
            std::ffi::OsString::from_vec(vec![0xFF])
        };
        let err = from_env(Err(VarError::NotUnicode(raw))).unwrap_err();
        assert!(err.contains(OVERRIDE_ENV), "{err}");
    }

    #[test]
    fn instrument_tracks_always_use_the_piano_detector() {
        assert_eq!(for_track(true).unwrap(), "piano");
    }

    // The commands must not decide the algorithm themselves: a hard-coded name
    // would put the experiment override and the shipped default out of step.
    #[test]
    fn commands_do_not_name_an_algorithm() {
        let src = include_str!("commands.rs").replace("\r\n", "\n");
        let production = src.split("#[cfg(test)]").next().unwrap();
        for name in EXPERIMENTAL.iter().chain(&[INSTRUMENT]) {
            assert!(
                !production.contains(&format!("\"{name}\"")),
                "commands.rs hard-codes the algorithm {name:?}; ask crate::pitch"
            );
        }
        assert!(!production.contains("algorithm: Option<String>"), "algorithm must not be an IPC argument");
    }
}
