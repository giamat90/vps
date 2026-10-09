//! Synced lyrics: persistence of `{song}/lyrics.json` and the sidecar round trip
//! that produces it. The Tauri command wrappers live in `commands.rs`.

use crate::commands::SidecarState;
use crate::library;
use crate::sidecar::{SidecarManager, SidecarMessage};
use crate::storage;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const FORMAT_VERSION: u32 = 1;
const LYRICS_FILE: &str = "lyrics.json";
/// Per message, not in total: the sidecar reports progress while it downloads
/// the model (first use only) and while it listens to the vocals.
const SIDECAR_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricWord {
    pub text: String,
    pub start: f64,
    pub end: f64,
    #[serde(default)]
    pub score: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricLine {
    pub text: String,
    pub start: f64,
    pub end: f64,
    #[serde(default)]
    pub score: f64,
    #[serde(default)]
    pub words: Vec<LyricWord>,
}

/// A song's lyrics with the time of every line and word on the vocals stem.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lyrics {
    #[serde(default = "format_version")]
    pub version: u32,
    /// "paste" (typed or pasted by the user) or "lrclib" (fetched).
    #[serde(default = "default_source")]
    pub source: String,
    /// The text exactly as the user supplied it, so it can be edited and re-synced.
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub aligner: String,
    #[serde(default)]
    pub aligned_at: String,
    #[serde(default)]
    pub mean_score: f64,
    /// Set when the sidecar doubts the text fits the recording.
    #[serde(default)]
    pub warning: Option<String>,
    pub lines: Vec<LyricLine>,
}

fn format_version() -> u32 {
    FORMAT_VERSION
}

fn default_source() -> String {
    "paste".to_string()
}

/// A candidate found online, shown for review before it is synced.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundLyrics {
    pub text: String,
    #[serde(default)]
    pub synced: bool,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub source: String,
}

fn lyrics_path(song_id: &str) -> std::path::PathBuf {
    storage::song_dir(song_id).join(LYRICS_FILE)
}

/// `Ok(None)` when the song has no lyrics yet; an unreadable file is an error
/// rather than "no lyrics", so a corrupt file is never silently overwritten.
pub fn load(song_id: &str) -> Result<Option<Lyrics>, String> {
    let path = lyrics_path(song_id);
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("Read lyrics: {e}"))?;
    serde_json::from_str(&raw).map(Some).map_err(|e| format!("Parse lyrics: {e}"))
}

/// Written beside the target and renamed into place, so a crash mid-write can
/// never leave a half-written (unparseable) lyrics.json behind.
fn save(song_id: &str, lyrics: &Lyrics) -> Result<(), String> {
    let json = serde_json::to_string_pretty(lyrics).map_err(|e| format!("Serialize lyrics: {e}"))?;
    let path = lyrics_path(song_id);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("Write lyrics: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Write lyrics: {e}"))
}

pub fn delete(song_id: &str) -> Result<(), String> {
    match std::fs::remove_file(lyrics_path(song_id)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Delete lyrics: {e}")),
    }
}

/// Build the stored record from the sidecar's `align_lyrics` result.
pub fn from_alignment(source: &str, text: &str, data: &serde_json::Value, aligned_at: String) -> Result<Lyrics, String> {
    let lines: Vec<LyricLine> = serde_json::from_value(data.get("lines").cloned().unwrap_or_default())
        .map_err(|e| format!("The sidecar returned malformed lyrics: {e}"))?;
    if lines.is_empty() {
        return Err("The sidecar returned no lyric lines".to_string());
    }
    Ok(Lyrics {
        version: FORMAT_VERSION,
        source: source.to_string(),
        text: text.to_string(),
        aligner: data.get("aligner").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        aligned_at,
        mean_score: data.get("meanScore").and_then(|v| v.as_f64()).unwrap_or(0.0),
        warning: data.get("warning").and_then(|v| v.as_str()).map(|s| s.to_string()),
        lines,
    })
}

fn ensure_sidecar(state: &SidecarState) -> Result<std::sync::MutexGuard<'_, Option<SidecarManager>>, String> {
    let mut guard = state.0.lock().map_err(|e| format!("lock: {e}"))?;
    if guard.is_none() {
        log::info!("Spawning sidecar for lyrics");
        *guard = Some(SidecarManager::spawn()?);
    }
    Ok(guard)
}

fn find_song(song_id: &str) -> Result<library::Song, String> {
    library::load_songs()?
        .into_iter()
        .find(|s| s.id == song_id)
        .ok_or_else(|| format!("Song not found: {song_id}"))
}

/// Align `text` to the song's vocals stem, persist and return the result.
/// `on_progress(fraction, stage)` is called as the sidecar reports.
pub fn sync_impl(
    state: &SidecarState,
    song_id: &str,
    text: &str,
    source: &str,
    on_progress: &mut dyn FnMut(f32, &str),
) -> Result<Lyrics, String> {
    if text.trim().is_empty() {
        return Err("Paste the lyrics first.".to_string());
    }
    let song = find_song(song_id)?;
    if song.kind == "instrument" {
        return Err("Lyrics sync needs a vocal track; this song was imported as an instrument.".to_string());
    }
    let vocals = storage::song_dir(song_id).join("vocals.wav");
    if !vocals.exists() {
        return Err("This song has no separated vocals to sync lyrics to.".to_string());
    }

    let cmd = serde_json::json!({
        "cmd": "align_lyrics",
        "vocalsPath": vocals.to_string_lossy(),
        "lyrics": text,
        "modelsDir": storage::app_data_dir().join("models").to_string_lossy(),
    });
    let guard = ensure_sidecar(state)?;
    let sidecar = guard.as_ref().ok_or("Sidecar not available")?;
    sidecar.send_command(&cmd)?;

    loop {
        match sidecar.recv_timeout(SIDECAR_TIMEOUT)? {
            SidecarMessage::Progress { value, stage, .. } => on_progress(value, &stage),
            SidecarMessage::Result { data, .. } => {
                let lyrics = from_alignment(source, text, &data, chrono::Utc::now().to_rfc3339())?;
                save(song_id, &lyrics)?;
                return Ok(lyrics);
            }
            SidecarMessage::Error { message, traceback, .. } => {
                log::error!("Lyrics sync failed: {message}\n{}", traceback.unwrap_or_default());
                return Err(message);
            }
            _ => {}
        }
    }
}

/// Look the song's lyrics up online; the user reviews the text before syncing.
pub fn find_impl(state: &SidecarState, song_id: &str) -> Result<FoundLyrics, String> {
    let song = find_song(song_id)?;
    let cmd = serde_json::json!({
        "cmd": "find_lyrics",
        "title": song.title,
        "artist": song.artist,
        "duration": if song.duration > 0.0 { Some(song.duration) } else { None },
    });
    let guard = ensure_sidecar(state)?;
    let sidecar = guard.as_ref().ok_or("Sidecar not available")?;
    sidecar.send_command(&cmd)?;

    loop {
        match sidecar.recv_timeout(Duration::from_secs(60))? {
            SidecarMessage::Result { data, .. } => {
                return serde_json::from_value(data).map_err(|e| format!("The sidecar returned malformed lyrics: {e}"));
            }
            SidecarMessage::Error { message, .. } => return Err(message),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_support::TestHome;
    use serde_json::json;

    fn offline_state() -> SidecarState {
        SidecarState(std::sync::Mutex::new(None))
    }

    fn spawned(state: &SidecarState) -> bool {
        state.0.lock().unwrap().is_some()
    }

    fn song(id: &str, kind: &str) -> library::Song {
        library::Song {
            id: id.to_string(),
            title: "A Song".to_string(),
            artist: None,
            duration: 100.0,
            detected_key: None,
            detected_bpm: None,
            processed_at: "2026-01-01T00:00:00Z".to_string(),
            directory: String::new(),
            kind: kind.to_string(),
            metronome_offset: None,
            folder_id: None,
            sort_index: 0,
        }
    }

    fn sample() -> Lyrics {
        Lyrics {
            version: 1,
            source: "paste".into(),
            text: "hello world".into(),
            aligner: "test".into(),
            aligned_at: "2026-01-01T00:00:00Z".into(),
            mean_score: 0.5,
            warning: None,
            lines: vec![LyricLine {
                text: "hello world".into(),
                start: 1.0,
                end: 2.5,
                score: 0.5,
                words: vec![
                    LyricWord { text: "hello".into(), start: 1.0, end: 1.5, score: 0.6 },
                    LyricWord { text: "world".into(), start: 1.8, end: 2.5, score: 0.4 },
                ],
            }],
        }
    }

    #[test]
    fn lyrics_serialize_camel_case() {
        let v = serde_json::to_value(sample()).unwrap();
        assert_eq!(v["alignedAt"], "2026-01-01T00:00:00Z");
        assert_eq!(v["meanScore"], 0.5);
        assert_eq!(v["lines"][0]["words"][1]["text"], "world");
        assert!(v.get("aligned_at").is_none());
    }

    #[test]
    fn a_minimal_file_parses_with_defaults() {
        let l: Lyrics = serde_json::from_value(json!({"lines": [{"text": "a", "start": 1.0, "end": 2.0}]})).unwrap();
        assert_eq!(l.version, 1);
        assert_eq!(l.source, "paste");
        assert!(l.warning.is_none());
        assert!(l.lines[0].words.is_empty());
    }

    #[test]
    fn save_load_and_delete_round_trip() {
        let _home = TestHome::new();
        assert_eq!(load("s1").unwrap(), None, "a song without lyrics loads as None");

        save("s1", &sample()).unwrap();
        assert_eq!(load("s1").unwrap(), Some(sample()));
        assert_eq!(load("s2").unwrap(), None, "lyrics belong to one song");

        delete("s1").unwrap();
        assert_eq!(load("s1").unwrap(), None);
        delete("s1").expect("deleting lyrics that are not there is not an error");
    }

    #[test]
    fn saving_leaves_no_temporary_file_and_replaces_an_existing_one() {
        let _home = TestHome::new();
        save("s1", &sample()).unwrap();
        let mut changed = sample();
        changed.text = "second version".into();
        save("s1", &changed).unwrap();

        assert_eq!(load("s1").unwrap().unwrap().text, "second version");
        let leftovers: Vec<_> = std::fs::read_dir(storage::song_dir("s1"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn a_corrupt_file_is_reported_not_treated_as_empty() {
        let _home = TestHome::new();
        std::fs::write(lyrics_path("s1"), "{not json").unwrap();
        assert!(load("s1").unwrap_err().contains("Parse lyrics"));
    }

    #[test]
    fn the_stored_record_is_built_from_the_sidecar_result() {
        let data = json!({
            "aligner": "wav2vec2-base-960h",
            "meanScore": 0.41,
            "warning": "check the text",
            "lines": [{"text": "la", "start": 1.0, "end": 1.4, "score": 0.4,
                       "words": [{"text": "la", "start": 1.0, "end": 1.4, "score": 0.4}]}],
        });
        let l = from_alignment("lrclib", "la", &data, "2026-02-02T00:00:00Z".into()).unwrap();
        assert_eq!(l.source, "lrclib");
        assert_eq!(l.text, "la");
        assert_eq!(l.aligner, "wav2vec2-base-960h");
        assert_eq!(l.warning.as_deref(), Some("check the text"));
        assert_eq!(l.lines[0].words[0].end, 1.4);
    }

    #[test]
    fn a_null_warning_means_no_warning() {
        let data = json!({"warning": null, "lines": [{"text": "a", "start": 0.0, "end": 1.0}]});
        assert!(from_alignment("paste", "a", &data, String::new()).unwrap().warning.is_none());
    }

    #[test]
    fn malformed_or_empty_results_are_rejected() {
        assert!(from_alignment("paste", "a", &json!({}), String::new()).is_err());
        assert!(from_alignment("paste", "a", &json!({"lines": []}), String::new()).is_err());
        assert!(from_alignment("paste", "a", &json!({"lines": [{"text": 3}]}), String::new()).is_err());
    }

    #[test]
    fn syncing_refuses_empty_text_without_starting_the_sidecar() {
        let _home = TestHome::new();
        let state = offline_state();
        let err = sync_impl(&state, "s1", "  \n ", "paste", &mut |_, _| {}).unwrap_err();
        assert!(err.contains("Paste the lyrics"));
        assert!(!spawned(&state));
    }

    #[test]
    fn syncing_an_unknown_song_is_reported() {
        let _home = TestHome::new();
        let state = offline_state();
        let err = sync_impl(&state, "ghost", "la la", "paste", &mut |_, _| {}).unwrap_err();
        assert!(err.contains("Song not found"));
        assert!(!spawned(&state));
    }

    #[test]
    fn an_instrument_track_has_no_vocals_to_sync() {
        let _home = TestHome::new();
        library::add(song("piano", "instrument")).unwrap();
        let state = offline_state();
        let err = sync_impl(&state, "piano", "la la", "paste", &mut |_, _| {}).unwrap_err();
        assert!(err.contains("instrument"));
        assert!(!spawned(&state));
    }

    #[test]
    fn a_song_without_a_vocals_file_is_reported() {
        let _home = TestHome::new();
        library::add(song("s1", "vocal")).unwrap();
        let state = offline_state();
        let err = sync_impl(&state, "s1", "la la", "paste", &mut |_, _| {}).unwrap_err();
        assert!(err.contains("no separated vocals"));
        assert!(!spawned(&state));
    }

    #[test]
    fn finding_lyrics_for_an_unknown_song_is_reported() {
        let _home = TestHome::new();
        let state = offline_state();
        assert!(find_impl(&state, "ghost").unwrap_err().contains("Song not found"));
        assert!(!spawned(&state));
    }

    #[test]
    fn found_lyrics_deserialize_from_the_sidecar_reply() {
        let f: FoundLyrics = serde_json::from_value(json!({
            "text": "a\nb", "synced": true, "title": "T", "artist": "A", "duration": 200.0, "source": "lrclib"
        }))
        .unwrap();
        assert!(f.synced);
        assert_eq!(f.text, "a\nb");
    }
}
