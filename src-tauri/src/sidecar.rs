//! The Python sidecar process. Starting it and the JSON-lines protocol live in
//! mps-core's `mps-sidecar` crate, shared with SPS; this module binds them to
//! VPS's binary name.

use std::ops::{Deref, DerefMut};

use mps_sidecar::SidecarConfig;
pub use mps_sidecar::SidecarMessage;

const CONFIG: SidecarConfig = SidecarConfig { binary_name: "vps-sidecar" };

/// The running sidecar. Everything but `spawn` is `mps_sidecar::SidecarManager`'s.
pub struct SidecarManager(mps_sidecar::SidecarManager);

impl SidecarManager {
    pub fn spawn() -> Result<Self, String> {
        mps_sidecar::SidecarManager::spawn(&CONFIG).map(Self)
    }
}

impl Deref for SidecarManager {
    type Target = mps_sidecar::SidecarManager;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl DerefMut for SidecarManager {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_support::TestHome;
    use crate::test_util::sidecar_unavailable;
    use std::time::Duration;

    fn parse(line: &str) -> Result<SidecarMessage, serde_json::Error> {
        serde_json::from_str(line)
    }

    #[test]
    fn every_message_the_python_side_sends_is_known_to_rust() {
        let main_py = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../sidecar/main.py")).unwrap();
        let mut sent: Vec<String> = main_py
            .split("\"type\": \"")
            .skip(1)
            .map(|rest| rest.split('"').next().unwrap().to_string())
            .collect();
        sent.sort();
        sent.dedup();
        assert!(!sent.is_empty());
        for kind in sent {
            let line = match kind.as_str() {
                "progress" => r#"{"type":"progress","value":0.0,"stage":"s"}"#.to_string(),
                "result" => r#"{"type":"result","cmd":"c","data":{}}"#.to_string(),
                "error" => r#"{"type":"error","message":"m"}"#.to_string(),
                other => format!(r#"{{"type":"{other}"}}"#),
            };
            assert!(parse(&line).is_ok(), "Rust cannot parse the \"{kind}\" message main.py sends");
        }
    }

    // ── live process ──────────────────────────────────────────────────────

    fn next_non_progress(m: &SidecarManager, secs: u64) -> SidecarMessage {
        loop {
            match m.recv_timeout(Duration::from_secs(secs)).expect("sidecar reply") {
                SidecarMessage::Progress { .. } => continue,
                other => return other,
            }
        }
    }

    #[test]
    fn the_real_sidecar_speaks_the_protocol_and_survives_bad_input() {
        let home = TestHome::new();
        // The sidecar caches its yt-dlp freshness check under ~; keep it out of the real home.
        std::env::set_var("USERPROFILE", home.path());
        std::env::set_var("HOME", home.path());

        let m = match SidecarManager::spawn() {
            Ok(m) => m,
            Err(e) => return sidecar_unavailable(&e),
        };

        m.send_command(&serde_json::json!({"cmd": "ping"})).unwrap();
        assert!(matches!(next_non_progress(&m, 30), SidecarMessage::Pong));

        m.send_line("this is not json").unwrap();
        match next_non_progress(&m, 30) {
            SidecarMessage::Error { message, .. } => assert!(message.contains("Invalid JSON"), "{message}"),
            other => panic!("expected an error, got {other:?}"),
        }

        m.send_command(&serde_json::json!({"cmd": "definitely_not_a_command"})).unwrap();
        match next_non_progress(&m, 30) {
            SidecarMessage::Error { message, .. } => assert!(message.contains("Unknown command"), "{message}"),
            other => panic!("expected an error, got {other:?}"),
        }

        // A command that raises inside Python comes back as an error with the command name and a traceback,
        // and does not take the loop down.
        m.send_command(&serde_json::json!({"cmd": "compute_st_spectrum", "audioPath": "/no/such/file.wav"})).unwrap();
        match next_non_progress(&m, 60) {
            SidecarMessage::Error { cmd, traceback, .. } => {
                assert_eq!(cmd.as_deref(), Some("compute_st_spectrum"));
                assert!(traceback.is_some());
            }
            other => panic!("expected an error, got {other:?}"),
        }

        m.send_command(&serde_json::json!({"cmd": "compute_st_spectrum"})).unwrap();
        assert!(matches!(next_non_progress(&m, 30), SidecarMessage::Error { .. }), "missing argument is an error, not a crash");

        m.send_command(&serde_json::json!({"cmd": "ping"})).unwrap();
        assert!(matches!(next_non_progress(&m, 30), SidecarMessage::Pong), "still alive after the errors");

        m.send_command(&serde_json::json!({"cmd": "quit"})).unwrap();
        assert!(matches!(next_non_progress(&m, 30), SidecarMessage::Bye));
    }

    #[test]
    fn non_ascii_paths_reach_the_sidecar_intact() {
        let home = TestHome::new();
        std::env::set_var("USERPROFILE", home.path());
        std::env::set_var("HOME", home.path());
        let m = match SidecarManager::spawn() {
            Ok(m) => m,
            Err(e) => return sidecar_unavailable(&e),
        };
        let dir = home.path().join("Música – 日本語");
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("tono.wav");
        crate::test_util::write_wav(&wav, &crate::test_util::tones(&[(440.0, 0.5)], 22050, 1.0), 22050);

        m.send_command(&serde_json::json!({"cmd": "compute_st_spectrum", "audioPath": wav.to_string_lossy()})).unwrap();
        match next_non_progress(&m, 120) {
            SidecarMessage::Result { data, .. } => assert!(data["stSpectrumFrames"].as_i64().unwrap() > 0),
            other => panic!("a UTF-8 path must round-trip (PYTHONUTF8 is forced by spawn): {other:?}"),
        }
    }
}
