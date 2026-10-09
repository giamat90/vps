use crate::library::{self, Song};
use crate::sidecar::{SidecarManager, SidecarMessage};
use crate::storage;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

/// Shared sidecar state — lazy-initialized on first use.
pub struct SidecarState(pub std::sync::Mutex<Option<SidecarManager>>);

/// Processing progress event payload (emitted to frontend).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessingStatus {
    pub song_id: String,
    pub progress: f32,
    pub stage: String,
    pub is_complete: bool,
    pub error: Option<String>,
}

/// Minimum stSpectrumBins for a cached blob to be considered current —
/// bumped from 128 to 1024 (sidecar's compute_short_term_spectrum) so a
/// precomputed frame looks as smooth as the live FFT panels. Acts as a
/// version marker like stSpectrumMinDb/MaxDb: any cached blob below this
/// predates the bump and gets transparently recomputed rather than left
/// stale at the old resolution.
/// Raised again 1024 -> 1152 when the window changed Chebyshev -> Blackman,
/// and 1152 -> 1280 when empty low-frequency log bins started being filled
/// from the nearest FFT bin: the bin count is only a cache-invalidation marker.
const ST_SPECTRUM_MIN_BINS: i64 = 1280;

/// True when a cached Short-Term Spectrum blob is complete and at least the
/// current resolution. Anything else (absent, empty, missing a dB bound, or a
/// lower bin count from before a bump) is recomputed by the backfill.
fn spectrum_is_current(b64: Option<&serde_json::Value>, min_db: Option<&serde_json::Value>, max_db: Option<&serde_json::Value>, bins: Option<&serde_json::Value>) -> bool {
    b64.and_then(|v| v.as_str()).is_some_and(|s| !s.is_empty())
        && min_db.is_some_and(|v| v.is_number())
        && max_db.is_some_and(|v| v.is_number())
        && bins.and_then(|v| v.as_i64()).is_some_and(|b| b >= ST_SPECTRUM_MIN_BINS)
}

fn analysis_has_current_spectrum(analysis: &serde_json::Value) -> bool {
    spectrum_is_current(
        analysis.get("stSpectrumB64"),
        analysis.get("stSpectrumMinDb"),
        analysis.get("stSpectrumMaxDb"),
        analysis.get("stSpectrumBins"),
    )
}

fn take_has_current_spectrum(take: &Take) -> bool {
    spectrum_is_current(
        take.st_spectrum_b64.as_ref(),
        take.st_spectrum_min_db.as_ref(),
        take.st_spectrum_max_db.as_ref(),
        take.st_spectrum_bins.as_ref(),
    )
}

/// Ensure sidecar is running, spawning if needed. Returns a lock guard.
fn ensure_sidecar(
    state: &SidecarState,
) -> Result<std::sync::MutexGuard<'_, Option<SidecarManager>>, String> {
    let mut guard = state.0.lock().map_err(|e| format!("lock: {e}"))?;
    if guard.is_none() {
        log::info!("Spawning sidecar for first use");
        *guard = Some(SidecarManager::spawn()?);
    }
    Ok(guard)
}

/// Backfill helper: compute the Short-Term Spectrum dataset for an audio file
/// already on disk, for library entries that predate this feature. Returns
/// None on any failure, always logged as a warning with the file concerned —
/// non-fatal, callers just skip the backfill and retry on the next open.
fn compute_st_spectrum(
    state: &SidecarState,
    audio_path: &str,
    audio_offset: f64,
) -> Option<serde_json::Value> {
    let guard = match ensure_sidecar(state) {
        Ok(guard) => guard,
        Err(e) => {
            log::warn!("compute_st_spectrum backfill skipped for {audio_path}: sidecar unavailable: {e}");
            return None;
        }
    };
    let Some(sidecar) = guard.as_ref() else {
        log::warn!("compute_st_spectrum backfill skipped for {audio_path}: sidecar not running");
        return None;
    };
    let cmd = serde_json::json!({
        "cmd": "compute_st_spectrum",
        "audioPath": audio_path,
        "audioOffset": audio_offset,
    });
    if let Err(e) = sidecar.send_command(&cmd) {
        log::warn!("compute_st_spectrum backfill skipped for {audio_path}: could not send command: {e}");
        return None;
    }
    let timeout = Duration::from_secs(120);
    loop {
        match sidecar.recv_timeout(timeout) {
            Ok(SidecarMessage::Result { data, .. }) => return Some(data),
            Ok(SidecarMessage::Error { message, .. }) => {
                log::warn!("compute_st_spectrum backfill error for {audio_path}: {message}");
                return None;
            }
            Ok(SidecarMessage::Progress { .. }) => continue,
            Ok(_) => {
                log::warn!("compute_st_spectrum backfill for {audio_path}: unexpected sidecar message");
                return None;
            }
            Err(e) => {
                log::warn!("compute_st_spectrum backfill for {audio_path}: no result: {e}");
                return None;
            }
        }
    }
}

/// A song job that failed in the sidecar never reached library.json, so nothing
/// else would ever clean up the copied source and any partial output.
fn remove_failed_job_dir(dir: &std::path::Path) {
    if let Err(e) = std::fs::remove_dir_all(dir) {
        log::warn!("Could not remove the directory of the failed job {}: {e}", dir.display());
    }
}

#[tauri::command]
pub async fn process_song(
    app: AppHandle,
    state: State<'_, SidecarState>,
    file_path: String,
    high_quality: Option<bool>,
    track_kind: Option<String>,
    algorithm: Option<String>,
) -> Result<Song, String> {
    let track_kind = track_kind.unwrap_or_else(|| "vocal".to_string());
    let skip_separation = track_kind == "instrument";
    // Instrument practice tracks (piano scales the singer pitches against) need
    // a monophonic-instrument detector, not the voice-tuned default — see
    // detect_pitch_piano in processor.py. Recorded takes stay on the vocal
    // algorithm (save_take passes `algorithm` unchanged).
    let algorithm = if skip_separation {
        Some("piano".to_string())
    } else {
        algorithm
    };
    let song_id = uuid::Uuid::new_v4().to_string();
    let output_dir = storage::song_dir(&song_id);

    // Copy source file into the song directory
    let src = std::path::Path::new(&file_path);
    if !src.exists() {
        return Err(format!("File not found: {file_path}"));
    }
    let file_name = src
        .file_name()
        .ok_or("Invalid file name")?
        .to_string_lossy();
    let title = src
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Unknown".to_string());
    let dest = output_dir.join(file_name.as_ref());
    std::fs::copy(src, &dest).map_err(|e| format!("Copy failed: {e}"))?;

    let output_dir_str = output_dir.to_string_lossy().to_string();
    let dest_str = dest.to_string_lossy().to_string();

    // Send process command to sidecar
    let cmd = serde_json::json!({
        "cmd": "process",
        "filePath": dest_str,
        "outputDir": output_dir_str,
        "highQuality": high_quality.unwrap_or(false),
        "skipSeparation": skip_separation,
        "algorithm": algorithm.unwrap_or_else(|| "srh".to_string()),
    });

    // Hold the lock for the duration of the processing to prevent concurrent jobs
    let guard = ensure_sidecar(&state)?;
    let sidecar = guard.as_ref().ok_or("Sidecar not available")?;
    sidecar.send_command(&cmd)?;

    // Read messages until we get a result or error
    let timeout = Duration::from_secs(600); // 10 min max for long songs
    loop {
        let msg = sidecar.recv_timeout(timeout)?;
        match msg {
            SidecarMessage::Progress { value, stage, .. } => {
                let _ = app.emit(
                    "processing-progress",
                    ProcessingStatus {
                        song_id: song_id.clone(),
                        progress: value,
                        stage,
                        is_complete: false,
                        error: None,
                    },
                );
            }
            SidecarMessage::Result { data, .. } => {
                let _ = app.emit(
                    "processing-progress",
                    ProcessingStatus {
                        song_id: song_id.clone(),
                        progress: 1.0,
                        stage: "complete".to_string(),
                        is_complete: true,
                        error: None,
                    },
                );

                // Extract metadata from result
                let detected_bpm = data.get("detectedBpm").and_then(|v| v.as_f64());
                let detected_key = data
                    .get("detectedKey")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                let duration = data.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0);

                let now = chrono::Utc::now().to_rfc3339();

                let song = Song {
                    id: song_id,
                    title,
                    artist: None,
                    duration,
                    detected_key,
                    detected_bpm,
                    processed_at: now,
                    directory: output_dir_str,
                    kind: track_kind.clone(),
                    metronome_offset: None,
                    folder_id: None,
                    sort_index: 0,
                };

                // Save analysis data to analysis.json
                let analysis = serde_json::json!({
                    "pitchData":    data.get("pitchData").cloned().unwrap_or(serde_json::Value::Array(vec![])),
                    "onsets":       data.get("onsets").cloned().unwrap_or(serde_json::Value::Array(vec![])),
                    "dynamics":     data.get("dynamics").cloned().unwrap_or(serde_json::Value::Array(vec![])),
                    "spectroTimes": data.get("spectroTimes").cloned().unwrap_or(serde_json::Value::Array(vec![])),
                    "spectroB64":   data.get("spectroB64").cloned().unwrap_or(serde_json::Value::String(String::new())),
                    "spectroFrames":data.get("spectroFrames").cloned().unwrap_or(serde_json::Value::Number(0.into())),
                    "spectroRows":  data.get("spectroRows").cloned().unwrap_or(serde_json::Value::Number(40.into())),
                    "stSpectrumTimes": data.get("stSpectrumTimes").cloned().unwrap_or(serde_json::Value::Array(vec![])),
                    "stSpectrumB64":   data.get("stSpectrumB64").cloned().unwrap_or(serde_json::Value::String(String::new())),
                    "stSpectrumFrames":data.get("stSpectrumFrames").cloned().unwrap_or(serde_json::Value::Number(0.into())),
                    "stSpectrumBins":  data.get("stSpectrumBins").cloned().unwrap_or(serde_json::Value::Number(0.into())),
                    "stSpectrumMinDb": data.get("stSpectrumMinDb").cloned().unwrap_or(serde_json::Value::Null),
                    "stSpectrumMaxDb": data.get("stSpectrumMaxDb").cloned().unwrap_or(serde_json::Value::Null),
                });
                let analysis_path = output_dir.join("analysis.json");
                if let Ok(json) = serde_json::to_string_pretty(&analysis) {
                    let _ = std::fs::write(&analysis_path, json);
                }

                // Persist to library.json
                library::add(song.clone())?;

                return Ok(song);
            }
            SidecarMessage::Error {
                message, traceback, ..
            } => {
                let detail = traceback.unwrap_or_default();
                log::error!("Sidecar error: {message}\n{detail}");
                let _ = app.emit(
                    "processing-progress",
                    ProcessingStatus {
                        song_id: song_id.clone(),
                        progress: 0.0,
                        stage: "error".to_string(),
                        is_complete: true,
                        error: Some(message.clone()),
                    },
                );
                remove_failed_job_dir(&output_dir);
                return Err(message);
            }
            _ => {}
        }
    }
}

#[tauri::command]
pub async fn pitch_shift_song(
    state: State<'_, SidecarState>,
    song_dir: String,
    n_steps: i32,
) -> Result<serde_json::Value, String> {
    let cache_dir = std::path::Path::new(&song_dir)
        .join("pitched")
        .join(n_steps.to_string());
    let vocals_cache = cache_dir.join("vocals.wav");
    let instr_cache = cache_dir.join("instrumental.wav");

    // Return cached result without touching the sidecar
    if vocals_cache.exists() && instr_cache.exists() {
        return Ok(serde_json::json!({
            "vocalsPath": vocals_cache.to_string_lossy(),
            "instrumentalPath": instr_cache.to_string_lossy(),
        }));
    }

    std::fs::create_dir_all(&cache_dir).map_err(|e| format!("mkdir: {e}"))?;

    let cmd = serde_json::json!({
        "cmd": "pitch_shift",
        "songDir": song_dir,
        "cacheDir": cache_dir.to_string_lossy(),
        "nSteps": n_steps,
    });
    let guard = ensure_sidecar(&state)?;
    let sidecar = guard.as_ref().ok_or("Sidecar not available")?;
    sidecar.send_command(&cmd)?;

    let timeout = Duration::from_secs(300);
    loop {
        let msg = sidecar.recv_timeout(timeout)?;
        match msg {
            SidecarMessage::Result { data, .. } => return Ok(data),
            SidecarMessage::Error { message, .. } => return Err(message),
            _ => {}
        }
    }
}

#[tauri::command]
pub async fn list_songs() -> Result<Vec<Song>, String> {
    library::load_songs()
}

#[tauri::command]
pub async fn delete_song(song_id: String) -> Result<(), String> {
    library::remove(&song_id)
}

#[tauri::command]
pub async fn set_metronome_offset(song_id: String, offset: Option<f64>) -> Result<Song, String> {
    library::update_metronome_offset(&song_id, offset)
}

#[tauri::command]
pub async fn rename_song(song_id: String, title: String) -> Result<Song, String> {
    library::rename(&song_id, &title)
}

// --- Folder commands ---

#[tauri::command]
pub async fn list_folders() -> Result<Vec<library::Folder>, String> {
    library::load_folders()
}

#[tauri::command]
pub async fn create_folder(name: String) -> Result<library::Folder, String> {
    library::create_folder(&name)
}

#[tauri::command]
pub async fn rename_folder(folder_id: String, name: String) -> Result<library::Folder, String> {
    library::rename_folder(&folder_id, &name)
}

#[tauri::command]
pub async fn delete_folder(folder_id: String) -> Result<(), String> {
    library::delete_folder(&folder_id)
}

#[tauri::command]
pub async fn reorder_folders(ordered_ids: Vec<String>) -> Result<Vec<library::Folder>, String> {
    library::reorder_folders(&ordered_ids)
}

#[tauri::command]
pub async fn move_songs(
    folder_id: Option<String>,
    ordered_song_ids: Vec<String>,
) -> Result<Vec<Song>, String> {
    library::move_songs(folder_id, &ordered_song_ids)
}

// --- Take commands ---

/// Take metadata for frontend (includes optional analysis data).
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Take {
    pub id: String,
    pub song_id: String,
    pub recorded_at: String,
    pub filepath: String,
    /// User-assigned display name; falls back to "Take N" in the UI when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Song position (seconds) where recording started; 0 for full-song takes.
    #[serde(default)]
    pub start_position: f64,
    /// Seconds into the audio file to skip on playback (non-zero when latency
    /// compensation exceeds startPosition).
    #[serde(default, skip_serializing_if = "crate::commands::is_zero_f64")]
    pub audio_offset: f64,
    /// Seconds, signed; user drag nudge applied on top of start_position to fine-tune
    /// sync after the fact. 0 means untouched.
    #[serde(default, skip_serializing_if = "crate::commands::is_zero_f64")]
    pub manual_offset: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pitch_data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub onsets: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dynamics: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vibrato: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub st_spectrum_times: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub st_spectrum_b64: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub st_spectrum_frames: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub st_spectrum_bins: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub st_spectrum_min_db: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub st_spectrum_max_db: Option<serde_json::Value>,
}

pub fn is_zero_f64(v: &f64) -> bool { *v == 0.0 }

fn takes_json_path(song_id: &str) -> std::path::PathBuf {
    storage::song_dir(song_id).join("takes.json")
}

fn load_takes(song_id: &str) -> Result<Vec<Take>, String> {
    let path = takes_json_path(song_id);
    if !path.exists() {
        return Ok(vec![]);
    }
    let data = std::fs::read_to_string(&path).map_err(|e| format!("Read takes: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("Parse takes: {e}"))
}

fn save_takes(song_id: &str, takes: &[Take]) -> Result<(), String> {
    let path = takes_json_path(song_id);
    let data = serde_json::to_string_pretty(takes).map_err(|e| format!("Serialize: {e}"))?;
    std::fs::write(&path, data).map_err(|e| format!("Write takes: {e}"))
}

#[tauri::command]
pub async fn save_take(
    state: State<'_, SidecarState>,
    song_id: String,
    audio_data: Vec<u8>,
    start_position: f64,
    audio_offset: f64,
    algorithm: Option<String>,
) -> Result<Take, String> {
    save_take_impl(&state, song_id, audio_data, start_position, audio_offset, algorithm)
}

// The command bodies below take a plain `&SidecarState` rather than tauri's
// `State` extractor so tests can drive them without building a Tauri app.
pub(crate) fn save_take_impl(
    state: &SidecarState,
    song_id: String,
    audio_data: Vec<u8>,
    start_position: f64,
    audio_offset: f64,
    algorithm: Option<String>,
) -> Result<Take, String> {
    let take_id = uuid::Uuid::new_v4().to_string();
    let takes_dir = storage::song_dir(&song_id).join("takes");
    std::fs::create_dir_all(&takes_dir).map_err(|e| format!("Create takes dir: {e}"))?;

    let file_path = takes_dir.join(format!("{take_id}.webm"));
    std::fs::write(&file_path, &audio_data).map_err(|e| format!("Write take: {e}"))?;

    let file_path_str = file_path.to_string_lossy().to_string();
    let output_dir_str = takes_dir.to_string_lossy().to_string();
    let vocals_path = storage::song_dir(&song_id).join("vocals.wav");
    let reference_path_str = vocals_path.exists().then(|| vocals_path.to_string_lossy().to_string());

    // Analyze the recording via sidecar (also RMS-normalizes loudness against vocals.wav)
    let (pitch_data, onsets, dynamics, vibrato, st_spectrum_times, st_spectrum_b64, st_spectrum_frames, st_spectrum_bins, st_spectrum_min_db, st_spectrum_max_db, normalized_path) = {
        let guard = ensure_sidecar(state);
        if let Ok(guard) = guard {
            if let Some(sidecar) = guard.as_ref() {
                let mut cmd_obj = serde_json::json!({
                    "cmd": "analyze",
                    "recordingPath": file_path_str,
                    "outputDir": output_dir_str,
                    "audioOffset": audio_offset,
                    "algorithm": algorithm.clone().unwrap_or_else(|| "srh".to_string()),
                });
                if let Some(ref_path) = &reference_path_str {
                    cmd_obj["referencePath"] = serde_json::json!(ref_path);
                }
                let _ = sidecar.send_command(&cmd_obj);
                let timeout = std::time::Duration::from_secs(300);
                let mut result = (None, None, None, None, None, None, None, None, None, None, None);
                loop {
                    match sidecar.recv_timeout(timeout) {
                        Ok(SidecarMessage::Result { data, .. }) => {
                            result = (
                                data.get("pitchData").cloned(),
                                data.get("onsets").cloned(),
                                data.get("dynamics").cloned(),
                                data.get("vibrato").cloned(),
                                data.get("stSpectrumTimes").cloned(),
                                data.get("stSpectrumB64").cloned(),
                                data.get("stSpectrumFrames").cloned(),
                                data.get("stSpectrumBins").cloned(),
                                data.get("stSpectrumMinDb").cloned(),
                                data.get("stSpectrumMaxDb").cloned(),
                                data.get("normalizedPath").and_then(|v| v.as_str().map(|s| s.to_string())),
                            );
                            break;
                        }
                        Ok(SidecarMessage::Error { message, .. }) => {
                            log::warn!("Take analysis error: {message}");
                            break;
                        }
                        Ok(SidecarMessage::Progress { .. }) => continue,
                        _ => break,
                    }
                }
                result
            } else {
                (None, None, None, None, None, None, None, None, None, None, None)
            }
        } else {
            (None, None, None, None, None, None, None, None, None, None, None)
        }
    };

    // Prefer the loudness-normalized WAV; fall back to the raw webm if normalization failed.
    let final_file_path_str = match &normalized_path {
        Some(p) => {
            if let Err(e) = std::fs::remove_file(&file_path) {
                log::warn!("Could not remove raw take recording {file_path_str}: {e}");
            }
            p.clone()
        }
        None => file_path_str,
    };

    let take = Take {
        id: take_id,
        song_id: song_id.clone(),
        recorded_at: chrono::Utc::now().to_rfc3339(),
        filepath: final_file_path_str,
        name: None,
        start_position,
        audio_offset,
        manual_offset: 0.0,
        pitch_data,
        onsets,
        dynamics,
        vibrato,
        st_spectrum_times,
        st_spectrum_b64,
        st_spectrum_frames,
        st_spectrum_bins,
        st_spectrum_min_db,
        st_spectrum_max_db,
    };

    let mut takes = load_takes(&song_id)?;
    takes.push(take.clone());
    save_takes(&song_id, &takes)?;

    Ok(take)
}

#[tauri::command]
pub async fn load_analysis(
    state: State<'_, SidecarState>,
    song_id: String,
) -> Result<serde_json::Value, String> {
    load_analysis_impl(&state, &song_id)
}

pub(crate) fn load_analysis_impl(state: &SidecarState, song_id: &str) -> Result<serde_json::Value, String> {
    let song_dir = storage::song_dir(song_id);
    let path = song_dir.join("analysis.json");
    if !path.exists() {
        return Ok(serde_json::json!({"pitchData": [], "onsets": [], "dynamics": []}));
    }
    let data = std::fs::read_to_string(&path).map_err(|e| format!("Read analysis: {e}"))?;
    let mut analysis: serde_json::Value =
        serde_json::from_str(&data).map_err(|e| format!("Parse analysis: {e}"))?;

    // Backfill: songs processed before the Short-Term Spectrum feature (or
    // before its dB range was widened to -100..0, or before its resolution
    // was raised to ST_SPECTRUM_MIN_BINS) won't have all three version-marker
    // fields in analysis.json — any older/lower-res encoding is transparently
    // recomputed rather than misread or left stale. Uses the already-separated
    // vocals.wav, so future loads skip straight to the cached data.
    if !analysis_has_current_spectrum(&analysis) {
        let vocals_path = song_dir.join("vocals.wav");
        if vocals_path.exists() {
            if let Some(result) = compute_st_spectrum(state, &vocals_path.to_string_lossy(), 0.0) {
                if let Some(obj) = analysis.as_object_mut() {
                    for key in [
                        "stSpectrumTimes", "stSpectrumB64", "stSpectrumFrames",
                        "stSpectrumBins", "stSpectrumMinDb", "stSpectrumMaxDb",
                    ] {
                        if let Some(v) = result.get(key) {
                            obj.insert(key.to_string(), v.clone());
                        }
                    }
                }
                // The spectrum is already in the value returned below, so a failed
                // write only means the backfill runs again on the next open.
                match serde_json::to_string_pretty(&analysis) {
                    Ok(json) => {
                        if let Err(e) = std::fs::write(&path, json) {
                            log::warn!("Could not cache backfilled spectrum in {}: {e}", path.display());
                        }
                    }
                    Err(e) => log::warn!("Could not serialize backfilled analysis for {}: {e}", path.display()),
                }
            }
        }
    }

    Ok(analysis)
}

#[tauri::command]
pub async fn list_takes(state: State<'_, SidecarState>, song_id: String) -> Result<Vec<Take>, String> {
    list_takes_impl(&state, &song_id)
}

pub(crate) fn list_takes_impl(state: &SidecarState, song_id: &str) -> Result<Vec<Take>, String> {
    let mut takes = load_takes(song_id)?;
    let mut changed = false;

    // Same backfill/version-marker logic as load_analysis, per-take, using
    // each take's own recording file and stored latency offset.
    for take in takes.iter_mut() {
        if take_has_current_spectrum(take) || !std::path::Path::new(&take.filepath).exists() {
            continue;
        }
        if let Some(result) = compute_st_spectrum(state, &take.filepath, take.audio_offset) {
            take.st_spectrum_times = result.get("stSpectrumTimes").cloned();
            take.st_spectrum_b64 = result.get("stSpectrumB64").cloned();
            take.st_spectrum_frames = result.get("stSpectrumFrames").cloned();
            take.st_spectrum_bins = result.get("stSpectrumBins").cloned();
            take.st_spectrum_min_db = result.get("stSpectrumMinDb").cloned();
            take.st_spectrum_max_db = result.get("stSpectrumMaxDb").cloned();
            changed = true;
        }
    }

    if changed {
        save_takes(song_id, &takes)?;
    }
    Ok(takes)
}

#[tauri::command]
pub async fn delete_take(song_id: String, take_id: String) -> Result<(), String> {
    let takes = load_takes(&song_id)?;
    if let Some(take) = takes.iter().find(|t| t.id == take_id) {
        let path = std::path::Path::new(&take.filepath);
        if path.exists() {
            std::fs::remove_file(path).map_err(|e| format!("Delete take file: {e}"))?;
        }
    }
    let filtered: Vec<Take> = takes.into_iter().filter(|t| t.id != take_id).collect();
    save_takes(&song_id, &filtered)
}

#[tauri::command]
pub async fn rename_take(song_id: String, take_id: String, name: String) -> Result<Take, String> {
    let mut takes = load_takes(&song_id)?;
    let trimmed = name.trim();
    let take = takes
        .iter_mut()
        .find(|t| t.id == take_id)
        .ok_or_else(|| format!("Take not found: {take_id}"))?;
    take.name = if trimmed.is_empty() { None } else { Some(trimmed.to_string()) };
    let updated = take.clone();
    save_takes(&song_id, &takes)?;
    Ok(updated)
}

#[tauri::command]
pub async fn set_take_manual_offset(song_id: String, take_id: String, offset: f64) -> Result<Take, String> {
    let mut takes = load_takes(&song_id)?;
    let take = takes
        .iter_mut()
        .find(|t| t.id == take_id)
        .ok_or_else(|| format!("Take not found: {take_id}"))?;
    take.manual_offset = offset;
    let updated = take.clone();
    save_takes(&song_id, &takes)?;
    Ok(updated)
}

// --- Exercise take commands ---

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExerciseTake {
    pub id: String,
    pub recorded_at: String,
    pub filepath: String,
    pub duration: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pitch_data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dynamics: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vibrato: Option<serde_json::Value>,
}

fn exercises_json_path() -> std::path::PathBuf {
    storage::exercises_dir().join("exercises.json")
}

fn load_exercise_takes() -> Result<Vec<ExerciseTake>, String> {
    let path = exercises_json_path();
    if !path.exists() {
        return Ok(vec![]);
    }
    let data = std::fs::read_to_string(&path).map_err(|e| format!("Read exercises: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("Parse exercises: {e}"))
}

fn save_exercise_takes_list(takes: &[ExerciseTake]) -> Result<(), String> {
    let path = exercises_json_path();
    let data = serde_json::to_string_pretty(takes).map_err(|e| format!("Serialize: {e}"))?;
    std::fs::write(&path, data).map_err(|e| format!("Write exercises: {e}"))
}

// Shared by save_exercise_take (raw recorded bytes) and import_exercise_file
// (an arbitrary external file copied in) — both need: sidecar `analyze`,
// preferring its loudness-normalized output over the raw/copied file, then
// build + persist the resulting ExerciseTake.
fn analyze_and_persist_exercise_take(
    state: &SidecarState,
    analyze_path: &str,
    raw_file_path: String,
    output_dir_str: &str,
    take_id: String,
    duration: f64,
    algorithm: Option<String>,
) -> Result<ExerciseTake, String> {
    let (pitch_data, dynamics, vibrato, normalized_path) = {
        let guard = ensure_sidecar(state);
        if let Ok(guard) = guard {
            if let Some(sidecar) = guard.as_ref() {
                let cmd = serde_json::json!({
                    "cmd": "analyze",
                    "recordingPath": analyze_path,
                    "outputDir": output_dir_str,
                    "algorithm": algorithm.unwrap_or_else(|| "srh".to_string()),
                });
                let _ = sidecar.send_command(&cmd);
                let timeout = std::time::Duration::from_secs(300);
                let mut result = (None, None, None, None);
                loop {
                    match sidecar.recv_timeout(timeout) {
                        Ok(SidecarMessage::Result { data, .. }) => {
                            result = (
                                data.get("pitchData").cloned(),
                                data.get("dynamics").cloned(),
                                data.get("vibrato").cloned(),
                                data.get("normalizedPath").and_then(|v| v.as_str().map(|s| s.to_string())),
                            );
                            break;
                        }
                        Ok(SidecarMessage::Error { message, .. }) => {
                            log::warn!("Exercise take analysis error: {message}");
                            break;
                        }
                        Ok(SidecarMessage::Progress { .. }) => continue,
                        _ => break,
                    }
                }
                result
            } else {
                (None, None, None, None)
            }
        } else {
            (None, None, None, None)
        }
    };

    // Prefer the loudness-normalized WAV; fall back to the raw/copied file if normalization failed.
    // The sidecar derives the normalized path by swapping the raw file's extension for
    // ".wav" (see analysis.py) — if the raw file was ALREADY a .wav (e.g. an imported
    // file, unlike a recorded take's always-.webm raw file), that derived path is the
    // exact same file, and removing "raw_file_path" would delete the only copy that
    // exists. Only remove it when normalization actually produced a distinct file.
    let final_file_path_str = match &normalized_path {
        Some(p) if p != &raw_file_path => {
            if let Err(e) = std::fs::remove_file(&raw_file_path) {
                log::warn!("Could not remove raw exercise take recording {raw_file_path}: {e}");
            }
            p.clone()
        }
        Some(p) => p.clone(),
        None => raw_file_path,
    };

    let take = ExerciseTake {
        id: take_id,
        recorded_at: chrono::Utc::now().to_rfc3339(),
        filepath: final_file_path_str,
        duration,
        pitch_data,
        dynamics,
        vibrato,
    };

    let mut takes = load_exercise_takes()?;
    takes.push(take.clone());
    save_exercise_takes_list(&takes)?;

    Ok(take)
}

#[tauri::command]
pub async fn save_exercise_take(
    state: State<'_, SidecarState>,
    audio_data: Vec<u8>,
    duration: f64,
    algorithm: Option<String>,
) -> Result<ExerciseTake, String> {
    save_exercise_take_impl(&state, audio_data, duration, algorithm)
}

pub(crate) fn save_exercise_take_impl(
    state: &SidecarState,
    audio_data: Vec<u8>,
    duration: f64,
    algorithm: Option<String>,
) -> Result<ExerciseTake, String> {
    let take_id = uuid::Uuid::new_v4().to_string();
    let takes_dir = storage::exercises_takes_dir();

    let file_path = takes_dir.join(format!("{take_id}.webm"));
    std::fs::write(&file_path, &audio_data).map_err(|e| format!("Write exercise take: {e}"))?;

    let file_path_str = file_path.to_string_lossy().to_string();
    let output_dir_str = takes_dir.to_string_lossy().to_string();

    analyze_and_persist_exercise_take(state, &file_path_str, file_path_str.clone(), &output_dir_str, take_id, duration, algorithm)
}

#[tauri::command]
pub async fn import_exercise_file(
    state: State<'_, SidecarState>,
    file_path: String,
    duration: f64,
    algorithm: Option<String>,
) -> Result<ExerciseTake, String> {
    import_exercise_file_impl(&state, file_path, duration, algorithm)
}

pub(crate) fn import_exercise_file_impl(
    state: &SidecarState,
    file_path: String,
    duration: f64,
    algorithm: Option<String>,
) -> Result<ExerciseTake, String> {
    let take_id = uuid::Uuid::new_v4().to_string();
    let takes_dir = storage::exercises_takes_dir();
    std::fs::create_dir_all(&takes_dir).map_err(|e| format!("Create exercise takes dir: {e}"))?;

    let src = std::path::Path::new(&file_path);
    if !src.exists() {
        return Err(format!("File not found: {file_path}"));
    }
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("wav");
    let dest = takes_dir.join(format!("{take_id}.{ext}"));
    std::fs::copy(src, &dest).map_err(|e| format!("Copy imported exercise file: {e}"))?;

    let dest_str = dest.to_string_lossy().to_string();
    let output_dir_str = takes_dir.to_string_lossy().to_string();

    // Analyze the copied file, not the original source, so the persisted
    // ExerciseTake's filepath always matches what analyze actually ran against.
    analyze_and_persist_exercise_take(state, &dest_str, dest_str.clone(), &output_dir_str, take_id, duration, algorithm)
}

#[tauri::command]
pub async fn list_exercise_takes() -> Result<Vec<ExerciseTake>, String> {
    load_exercise_takes()
}

#[tauri::command]
pub async fn delete_exercise_take(take_id: String) -> Result<(), String> {
    let takes = load_exercise_takes()?;
    if let Some(take) = takes.iter().find(|t| t.id == take_id) {
        let path = std::path::Path::new(&take.filepath);
        if path.exists() {
            std::fs::remove_file(path).map_err(|e| format!("Delete exercise take file: {e}"))?;
        }
    }
    let filtered: Vec<ExerciseTake> = takes.into_iter().filter(|t| t.id != take_id).collect();
    save_exercise_takes_list(&filtered)
}

#[tauri::command]
pub async fn import_youtube(
    app: AppHandle,
    state: State<'_, SidecarState>,
    url: String,
    high_quality: Option<bool>,
    algorithm: Option<String>,
    cookies_path: Option<String>,
) -> Result<Song, String> {
    if !url.contains("youtube.com/") && !url.contains("youtu.be/") {
        return Err("Not a valid YouTube URL".to_string());
    }

    let song_id = uuid::Uuid::new_v4().to_string();
    let output_dir = storage::song_dir(&song_id);
    let output_dir_str = output_dir.to_string_lossy().to_string();

    let cmd = serde_json::json!({
        "cmd": "import_yt",
        "url": url,
        "outputDir": output_dir_str,
        "highQuality": high_quality.unwrap_or(false),
        "algorithm": algorithm.unwrap_or_else(|| "srh".to_string()),
        "cookiesPath": cookies_path,
    });

    let guard = ensure_sidecar(&state)?;
    let sidecar = guard.as_ref().ok_or("Sidecar not available")?;
    sidecar.send_command(&cmd)?;

    let timeout = Duration::from_secs(900);
    loop {
        let msg = sidecar.recv_timeout(timeout)?;
        match msg {
            SidecarMessage::Progress { value, stage, .. } => {
                let _ = app.emit(
                    "processing-progress",
                    ProcessingStatus {
                        song_id: song_id.clone(),
                        progress: value,
                        stage,
                        is_complete: false,
                        error: None,
                    },
                );
            }
            SidecarMessage::Result { data, .. } => {
                let _ = app.emit(
                    "processing-progress",
                    ProcessingStatus {
                        song_id: song_id.clone(),
                        progress: 1.0,
                        stage: "complete".to_string(),
                        is_complete: true,
                        error: None,
                    },
                );

                let title = data
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown")
                    .to_string();
                let detected_bpm = data.get("detectedBpm").and_then(|v| v.as_f64());
                let detected_key = data
                    .get("detectedKey")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let duration = data.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0);

                let song = Song {
                    id: song_id,
                    title,
                    artist: None,
                    duration,
                    detected_key,
                    detected_bpm,
                    processed_at: chrono::Utc::now().to_rfc3339(),
                    directory: output_dir_str,
                    kind: "vocal".to_string(),
                    metronome_offset: None,
                    folder_id: None,
                    sort_index: 0,
                };

                let analysis = serde_json::json!({
                    "pitchData":    data.get("pitchData").cloned().unwrap_or(serde_json::Value::Array(vec![])),
                    "onsets":       data.get("onsets").cloned().unwrap_or(serde_json::Value::Array(vec![])),
                    "dynamics":     data.get("dynamics").cloned().unwrap_or(serde_json::Value::Array(vec![])),
                    "spectroTimes": data.get("spectroTimes").cloned().unwrap_or(serde_json::Value::Array(vec![])),
                    "spectroB64":   data.get("spectroB64").cloned().unwrap_or(serde_json::Value::String(String::new())),
                    "spectroFrames":data.get("spectroFrames").cloned().unwrap_or(serde_json::Value::Number(0.into())),
                    "spectroRows":  data.get("spectroRows").cloned().unwrap_or(serde_json::Value::Number(40.into())),
                    "stSpectrumTimes": data.get("stSpectrumTimes").cloned().unwrap_or(serde_json::Value::Array(vec![])),
                    "stSpectrumB64":   data.get("stSpectrumB64").cloned().unwrap_or(serde_json::Value::String(String::new())),
                    "stSpectrumFrames":data.get("stSpectrumFrames").cloned().unwrap_or(serde_json::Value::Number(0.into())),
                    "stSpectrumBins":  data.get("stSpectrumBins").cloned().unwrap_or(serde_json::Value::Number(0.into())),
                    "stSpectrumMinDb": data.get("stSpectrumMinDb").cloned().unwrap_or(serde_json::Value::Null),
                    "stSpectrumMaxDb": data.get("stSpectrumMaxDb").cloned().unwrap_or(serde_json::Value::Null),
                });
                let analysis_path = output_dir.join("analysis.json");
                if let Ok(json) = serde_json::to_string_pretty(&analysis) {
                    let _ = std::fs::write(&analysis_path, json);
                }

                library::add(song.clone())?;
                return Ok(song);
            }
            SidecarMessage::Error {
                message, traceback, ..
            } => {
                let detail = traceback.unwrap_or_default();
                log::error!("YT import error: {message}\n{detail}");
                let _ = app.emit(
                    "processing-progress",
                    ProcessingStatus {
                        song_id: song_id.clone(),
                        progress: 0.0,
                        stage: "error".to_string(),
                        is_complete: true,
                        error: Some(message.clone()),
                    },
                );
                remove_failed_job_dir(&output_dir);
                return Err(message);
            }
            _ => {}
        }
    }
}

#[tauri::command]
pub async fn export_stem(
    app: AppHandle,
    stem_path: String,
    suggested_name: String,
) -> Result<(), String> {
    use tauri_plugin_dialog::DialogExt;

    let src = std::path::Path::new(&stem_path);
    if !src.exists() {
        return Err(format!("Stem not found: {stem_path}"));
    }

    let dest = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        let suggested_name = suggested_name.clone();
        move || {
            app.dialog()
                .file()
                .set_file_name(&suggested_name)
                .add_filter("Audio", &["wav"])
                .blocking_save_file()
        }
    })
    .await
    .map_err(|e| format!("Dialog task: {e}"))?;

    if let Some(path) = dest {
        std::fs::copy(src, path.as_path().ok_or("Invalid path")?)
            .map_err(|e| format!("Copy failed: {e}"))?;
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZipEntry {
    pub path: String,
    pub archive_name: String,
}

#[tauri::command]
pub async fn export_all(
    app: AppHandle,
    entries: Vec<ZipEntry>,
    suggested_name: String,
) -> Result<(), String> {
    use tauri_plugin_dialog::DialogExt;

    if entries.is_empty() {
        return Err("Nothing to export".to_string());
    }

    let dest = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        let suggested_name = suggested_name.clone();
        move || {
            app.dialog()
                .file()
                .set_file_name(&suggested_name)
                .add_filter("Zip Archive", &["zip"])
                .blocking_save_file()
        }
    })
    .await
    .map_err(|e| format!("Dialog task: {e}"))?;

    let Some(dest) = dest else { return Ok(()) };
    let dest_path = dest.as_path().ok_or("Invalid path")?.to_path_buf();

    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let file = std::fs::File::create(&dest_path).map_err(|e| format!("Create zip: {e}"))?;
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        for entry in &entries {
            let mut src = std::fs::File::open(&entry.path)
                .map_err(|e| format!("Open {}: {e}", entry.path))?;
            zip.start_file(&entry.archive_name, options)
                .map_err(|e| format!("Zip entry {}: {e}", entry.archive_name))?;
            std::io::copy(&mut src, &mut zip)
                .map_err(|e| format!("Write {}: {e}", entry.archive_name))?;
        }
        zip.finish().map_err(|e| format!("Finish zip: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Zip task: {e}"))??;

    Ok(())
}

#[tauri::command]
pub async fn export_take(
    app: AppHandle,
    state: State<'_, SidecarState>,
    take_path: String,
    suggested_name: String,
) -> Result<(), String> {
    use tauri_plugin_dialog::DialogExt;

    let src = std::path::Path::new(&take_path);
    if !src.exists() {
        return Err(format!("Take not found: {take_path}"));
    }

    // The take is typically webm/opus; decode it via the sidecar into a
    // temp WAV file, then offer that file through the Save-As dialog.
    let temp_path = std::env::temp_dir().join(format!("{}.wav", uuid::Uuid::new_v4()));
    let cmd = serde_json::json!({
        "cmd": "convert_take",
        "recordingPath": take_path,
        "outputPath": temp_path.to_string_lossy(),
    });
    {
        let guard = ensure_sidecar(&state)?;
        let sidecar = guard.as_ref().ok_or("Sidecar not available")?;
        sidecar.send_command(&cmd)?;

        let timeout = Duration::from_secs(120);
        loop {
            match sidecar.recv_timeout(timeout)? {
                SidecarMessage::Result { .. } => break,
                SidecarMessage::Error { message, .. } => return Err(message),
                _ => {}
            }
        }
    }
    let _temp_guard = TempFile(temp_path.clone());

    let dest = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        let suggested_name = suggested_name.clone();
        move || {
            app.dialog()
                .file()
                .set_file_name(&suggested_name)
                .add_filter("Audio", &["wav"])
                .blocking_save_file()
        }
    })
    .await
    .map_err(|e| format!("Dialog task: {e}"))?;

    if let Some(path) = dest {
        std::fs::copy(&temp_path, path.as_path().ok_or("Invalid path")?)
            .map_err(|e| format!("Copy failed: {e}"))?;
    }
    Ok(())
}

/// One track to include in an `export_mix` render. `gain` is the final
/// linear volume already resolved from mute/solo/volume by the frontend —
/// this command has no concept of mute/solo, only gains. `start_position`/
/// `audio_offset` are only meaningful for `is_take` sources (see the
/// `fileTime = projectTime - startPosition + audioOffset` mapping in
/// `player.ts`); omitted for plain stem/instrumental sources.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MixSource {
    pub path: String,
    pub gain: f64,
    pub is_take: bool,
    pub start_position: Option<f64>,
    pub audio_offset: Option<f64>,
    pub manual_offset: Option<f64>,
}

#[tauri::command]
pub async fn export_mix(
    app: AppHandle,
    state: State<'_, SidecarState>,
    sources: Vec<MixSource>,
    start_sec: f64,
    end_sec: f64,
    suggested_name: String,
) -> Result<(), String> {
    use tauri_plugin_dialog::DialogExt;

    if sources.is_empty() {
        return Err("No audible tracks to export".to_string());
    }

    let temp_path = std::env::temp_dir().join(format!("{}.wav", uuid::Uuid::new_v4()));
    let cmd = serde_json::json!({
        "cmd": "mix_export",
        "outputPath": temp_path.to_string_lossy(),
        "startSec": start_sec,
        "endSec": end_sec,
        "sources": sources,
    });
    {
        let guard = ensure_sidecar(&state)?;
        let sidecar = guard.as_ref().ok_or("Sidecar not available")?;
        sidecar.send_command(&cmd)?;

        let timeout = Duration::from_secs(120);
        loop {
            match sidecar.recv_timeout(timeout)? {
                SidecarMessage::Result { .. } => break,
                SidecarMessage::Error { message, .. } => return Err(message),
                _ => {}
            }
        }
    }
    let _temp_guard = TempFile(temp_path.clone());

    let dest = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        let suggested_name = suggested_name.clone();
        move || {
            app.dialog()
                .file()
                .set_file_name(&suggested_name)
                .add_filter("Audio", &["wav"])
                .blocking_save_file()
        }
    })
    .await
    .map_err(|e| format!("Dialog task: {e}"))?;

    if let Some(path) = dest {
        std::fs::copy(&temp_path, path.as_path().ok_or("Invalid path")?)
            .map_err(|e| format!("Copy failed: {e}"))?;
    }
    Ok(())
}

/// Deletes the wrapped temp file when dropped.
struct TempFile(std::path::PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        if let Err(e) = std::fs::remove_file(&self.0) {
            log::warn!("Failed to remove temp export file {:?}: {e}", self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_support::TestHome;
    use serde_json::json;

    fn run<F: std::future::Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    fn take(id: &str) -> Take {
        Take {
            id: id.to_string(),
            song_id: "s1".to_string(),
            recorded_at: "2026-01-01T00:00:00Z".to_string(),
            filepath: String::new(),
            name: None,
            start_position: 0.0,
            audio_offset: 0.0,
            manual_offset: 0.0,
            pitch_data: None,
            onsets: None,
            dynamics: None,
            vibrato: None,
            st_spectrum_times: None,
            st_spectrum_b64: None,
            st_spectrum_frames: None,
            st_spectrum_bins: None,
            st_spectrum_min_db: None,
            st_spectrum_max_db: None,
        }
    }

    fn with_spectrum(mut t: Take, bins: i64) -> Take {
        t.st_spectrum_b64 = Some(json!("AAAA"));
        t.st_spectrum_min_db = Some(json!(-100.0));
        t.st_spectrum_max_db = Some(json!(0.0));
        t.st_spectrum_bins = Some(json!(bins));
        t
    }

    fn write_takes(song_id: &str, takes: &[Take]) {
        save_takes(song_id, takes).unwrap();
    }

    fn offline_state() -> SidecarState {
        SidecarState(std::sync::Mutex::new(None))
    }

    fn sidecar_was_spawned(state: &SidecarState) -> bool {
        state.0.lock().unwrap().is_some()
    }

    // ── cache marker ──────────────────────────────────────────────────────

    #[test]
    fn spectrum_currency_requires_every_marker_at_the_current_resolution() {
        let full = json!({
            "stSpectrumB64": "AAAA", "stSpectrumMinDb": -100.0, "stSpectrumMaxDb": 0.0, "stSpectrumBins": ST_SPECTRUM_MIN_BINS,
        });
        assert!(analysis_has_current_spectrum(&full));

        let mut higher = full.clone();
        higher["stSpectrumBins"] = json!(ST_SPECTRUM_MIN_BINS + 512);
        assert!(analysis_has_current_spectrum(&higher), "a finer blob than required is fine");

        for (field, bad) in [
            ("stSpectrumB64", json!("")),
            ("stSpectrumB64", json!(null)),
            ("stSpectrumB64", json!(12)),
            ("stSpectrumMinDb", json!("-100")),
            ("stSpectrumMinDb", json!(null)),
            ("stSpectrumMaxDb", json!(null)),
            ("stSpectrumBins", json!(ST_SPECTRUM_MIN_BINS - 1)),
            ("stSpectrumBins", json!(1024)),
            ("stSpectrumBins", json!(128)),
            ("stSpectrumBins", json!("1280")),
            ("stSpectrumBins", json!(null)),
        ] {
            let mut v = full.clone();
            v[field] = bad.clone();
            assert!(!analysis_has_current_spectrum(&v), "{field}={bad} should be stale");
        }
        for field in ["stSpectrumB64", "stSpectrumMinDb", "stSpectrumMaxDb", "stSpectrumBins"] {
            let mut v = full.clone();
            v.as_object_mut().unwrap().remove(field);
            assert!(!analysis_has_current_spectrum(&v), "missing {field} should be stale");
        }
        assert!(!analysis_has_current_spectrum(&json!({})));
    }

    #[test]
    fn a_take_spectrum_is_current_only_at_the_current_resolution() {
        assert!(take_has_current_spectrum(&with_spectrum(take("t"), ST_SPECTRUM_MIN_BINS)));
        assert!(!take_has_current_spectrum(&with_spectrum(take("t"), ST_SPECTRUM_MIN_BINS - 1)));
        assert!(!take_has_current_spectrum(&take("t")));
        let mut no_min = with_spectrum(take("t"), ST_SPECTRUM_MIN_BINS);
        no_min.st_spectrum_min_db = None;
        assert!(!take_has_current_spectrum(&no_min));
    }

    #[test]
    fn the_cache_marker_matches_the_sidecars_bin_count() {
        let py = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../sidecar/processor.py")).unwrap();
        let line = py
            .lines()
            .find(|l| l.trim_start().starts_with("N_BINS ="))
            .expect("N_BINS assignment in processor.py");
        let bins: i64 = line.split('=').nth(1).unwrap().trim().parse().unwrap();
        assert_eq!(
            bins, ST_SPECTRUM_MIN_BINS,
            "a mismatch makes every blob look stale (recomputed on each open) or lets old ones through"
        );
    }

    // ── serde contract ────────────────────────────────────────────────────

    #[test]
    fn take_serializes_camel_case_and_omits_empty_optionals() {
        let v = serde_json::to_value(take("t")).unwrap();
        for key in ["id", "songId", "recordedAt", "filepath", "startPosition"] {
            assert!(v.get(key).is_some(), "missing {key}");
        }
        for key in ["name", "audioOffset", "manualOffset", "pitchData", "onsets", "dynamics", "vibrato", "stSpectrumB64"] {
            assert!(v.get(key).is_none(), "{key} should be omitted when empty");
        }
    }

    #[test]
    fn take_keeps_nonzero_offsets_and_spectrum_fields() {
        let mut t = with_spectrum(take("t"), ST_SPECTRUM_MIN_BINS);
        t.audio_offset = 0.25;
        t.manual_offset = -1.5;
        t.name = Some("Verse".into());
        let v = serde_json::to_value(&t).unwrap();
        assert_eq!(v["audioOffset"], 0.25);
        assert_eq!(v["manualOffset"], -1.5);
        assert_eq!(v["name"], "Verse");
        assert_eq!(v["stSpectrumBins"], ST_SPECTRUM_MIN_BINS);
    }

    #[test]
    fn take_from_an_old_takes_json_parses_with_defaults() {
        let old = r#"{"id":"t","songId":"s","recordedAt":"x","filepath":"/t.webm"}"#;
        let t: Take = serde_json::from_str(old).unwrap();
        assert_eq!((t.start_position, t.audio_offset, t.manual_offset), (0.0, 0.0, 0.0));
        assert!(t.name.is_none() && t.pitch_data.is_none());
    }

    #[test]
    fn take_round_trips_through_json() {
        let mut t = with_spectrum(take("t"), 2000);
        t.pitch_data = Some(json!({"times": [0.0], "f0": [220.0], "voiced": [true], "confidence": [0.9]}));
        t.manual_offset = 0.5;
        let back: Take = serde_json::from_str(&serde_json::to_string(&t).unwrap()).unwrap();
        assert_eq!(format!("{back:?}"), format!("{t:?}"));
    }

    #[test]
    fn processing_status_serializes_camel_case() {
        let v = serde_json::to_value(ProcessingStatus {
            song_id: "s".into(),
            progress: 0.5,
            stage: "pitch".into(),
            is_complete: false,
            error: None,
        })
        .unwrap();
        assert_eq!(v["songId"], "s");
        assert_eq!(v["isComplete"], false);
        assert!(v.get("is_complete").is_none());
    }

    // ── takes ─────────────────────────────────────────────────────────────

    #[test]
    fn takes_start_empty_and_survive_a_save_load_round_trip() {
        let _home = TestHome::new();
        assert!(load_takes("s1").unwrap().is_empty());
        write_takes("s1", &[take("a"), take("b")]);
        let loaded = load_takes("s1").unwrap();
        assert_eq!(loaded.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
    }

    #[test]
    fn takes_of_different_songs_do_not_mix() {
        let _home = TestHome::new();
        write_takes("s1", &[take("a")]);
        write_takes("s2", &[take("b")]);
        assert_eq!(load_takes("s1").unwrap()[0].id, "a");
        assert_eq!(load_takes("s2").unwrap()[0].id, "b");
    }

    #[test]
    fn a_corrupt_takes_file_is_reported() {
        let home = TestHome::new();
        let dir = home.path().join("library").join("s1");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("takes.json"), "oops").unwrap();
        assert!(load_takes("s1").unwrap_err().contains("Parse takes"));
    }

    #[test]
    fn rename_take_trims_and_empty_clears_back_to_the_default_label() {
        let _home = TestHome::new();
        write_takes("s1", &[take("a")]);
        let named = run(rename_take("s1".into(), "a".into(), "  Chorus  ".into())).unwrap();
        assert_eq!(named.name.as_deref(), Some("Chorus"));
        assert_eq!(load_takes("s1").unwrap()[0].name.as_deref(), Some("Chorus"));

        let cleared = run(rename_take("s1".into(), "a".into(), "   ".into())).unwrap();
        assert_eq!(cleared.name, None);
        assert_eq!(load_takes("s1").unwrap()[0].name, None);
    }

    #[test]
    fn rename_take_reports_an_unknown_take() {
        let _home = TestHome::new();
        write_takes("s1", &[take("a")]);
        let err = run(rename_take("s1".into(), "zzz".into(), "x".into())).unwrap_err();
        assert!(err.contains("zzz"));
    }

    #[test]
    fn set_take_manual_offset_persists_and_zero_resets() {
        let _home = TestHome::new();
        write_takes("s1", &[take("a")]);
        assert_eq!(run(set_take_manual_offset("s1".into(), "a".into(), -0.75)).unwrap().manual_offset, -0.75);
        assert_eq!(load_takes("s1").unwrap()[0].manual_offset, -0.75);
        run(set_take_manual_offset("s1".into(), "a".into(), 0.0)).unwrap();
        let raw = std::fs::read_to_string(storage::song_dir("s1").join("takes.json")).unwrap();
        assert!(!raw.contains("manualOffset"), "a zero offset is not stored");
        assert!(run(set_take_manual_offset("s1".into(), "ghost".into(), 1.0)).is_err());
    }

    #[test]
    fn delete_take_removes_the_entry_and_its_audio_file_only() {
        let home = TestHome::new();
        let file_a = home.path().join("a.wav");
        let file_b = home.path().join("b.wav");
        std::fs::write(&file_a, b"a").unwrap();
        std::fs::write(&file_b, b"b").unwrap();
        let (mut a, mut b) = (take("a"), take("b"));
        a.filepath = file_a.to_string_lossy().to_string();
        b.filepath = file_b.to_string_lossy().to_string();
        write_takes("s1", &[a, b]);

        run(delete_take("s1".into(), "a".into())).unwrap();

        assert!(!file_a.exists());
        assert!(file_b.exists());
        assert_eq!(load_takes("s1").unwrap().iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["b"]);
    }

    #[test]
    fn delete_take_copes_with_a_missing_file_and_an_unknown_id() {
        let _home = TestHome::new();
        let mut a = take("a");
        a.filepath = "/not/there.wav".into();
        write_takes("s1", &[a]);
        run(delete_take("s1".into(), "a".into())).unwrap();
        run(delete_take("s1".into(), "never".into())).unwrap();
        assert!(load_takes("s1").unwrap().is_empty());
    }

    // ── exercise takes ────────────────────────────────────────────────────

    #[test]
    fn exercise_takes_list_and_delete_with_their_files() {
        let home = TestHome::new();
        assert!(run(list_exercise_takes()).unwrap().is_empty());

        let file = home.path().join("e1.webm");
        std::fs::write(&file, b"x").unwrap();
        save_exercise_takes_list(&[
            ExerciseTake {
                id: "e1".into(), recorded_at: "x".into(), filepath: file.to_string_lossy().to_string(),
                duration: 3.5, pitch_data: None, dynamics: None, vibrato: None,
            },
            ExerciseTake {
                id: "e2".into(), recorded_at: "x".into(), filepath: "/gone.webm".into(),
                duration: 1.0, pitch_data: Some(json!({"times": []})), dynamics: None, vibrato: None,
            },
        ])
        .unwrap();

        let listed = run(list_exercise_takes()).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].duration, 3.5);

        run(delete_exercise_take("e1".into())).unwrap();
        assert!(!file.exists());
        run(delete_exercise_take("e2".into())).unwrap();
        run(delete_exercise_take("ghost".into())).unwrap();
        assert!(run(list_exercise_takes()).unwrap().is_empty());
    }

    #[test]
    fn exercise_take_serializes_camel_case_and_skips_missing_analysis() {
        let v = serde_json::to_value(ExerciseTake {
            id: "e".into(), recorded_at: "x".into(), filepath: "/e".into(), duration: 2.0,
            pitch_data: None, dynamics: None, vibrato: None,
        })
        .unwrap();
        assert!(v.get("recordedAt").is_some());
        assert!(v.get("pitchData").is_none());
    }

    #[test]
    fn a_corrupt_exercise_file_is_reported() {
        let home = TestHome::new();
        std::fs::create_dir_all(home.path().join("exercises")).unwrap();
        std::fs::write(home.path().join("exercises").join("exercises.json"), "[[").unwrap();
        assert!(run(list_exercise_takes()).unwrap_err().contains("Parse exercises"));
    }

    // ── failed jobs ───────────────────────────────────────────────────────

    #[test]
    fn a_failed_job_directory_is_removed_and_a_missing_one_tolerated() {
        let home = TestHome::new();
        let dir = storage::song_dir("failed-job");
        std::fs::write(dir.join("source.mp3"), b"x").unwrap();
        remove_failed_job_dir(&dir);
        assert!(!dir.exists());
        remove_failed_job_dir(&home.path().join("never-existed"));
    }

    // ── library command pass-throughs ─────────────────────────────────────

    #[test]
    fn library_commands_round_trip_through_the_real_store() {
        let _home = TestHome::new();
        assert!(run(list_songs()).unwrap().is_empty());
        library::add(Song {
            id: "a".into(), title: "A".into(), artist: None, duration: 1.0, detected_key: None, detected_bpm: None,
            processed_at: "x".into(), directory: storage::song_dir("a").to_string_lossy().to_string(),
            kind: "vocal".into(), metronome_offset: None, folder_id: None, sort_index: 0,
        })
        .unwrap();

        assert_eq!(run(rename_song("a".into(), " Renamed ".into())).unwrap().title, "Renamed");
        assert_eq!(run(set_metronome_offset("a".into(), Some(3.0))).unwrap().metronome_offset, Some(3.0));

        let folder = run(create_folder("Band".into())).unwrap();
        assert_eq!(run(rename_folder(folder.id.clone(), "Group".into())).unwrap().name, "Group");
        let moved = run(move_songs(Some(folder.id.clone()), vec!["a".into()])).unwrap();
        assert_eq!(moved[0].folder_id.as_deref(), Some(folder.id.as_str()));
        assert_eq!(run(reorder_folders(vec![folder.id.clone()])).unwrap()[0].sort_index, 0);
        run(delete_folder(folder.id)).unwrap();
        assert_eq!(run(list_songs()).unwrap()[0].folder_id, None);

        let dir = storage::song_dir("a");
        assert!(dir.exists());
        run(delete_song("a".into())).unwrap();
        assert!(!dir.exists());
        assert!(run(list_songs()).unwrap().is_empty());
    }

    // ── load_analysis / list_takes without needing the sidecar ────────────

    #[test]
    fn load_analysis_for_a_song_without_analysis_returns_the_empty_shape() {
        let _home = TestHome::new();
        let state = offline_state();
        let v = load_analysis_impl(&state, "fresh").unwrap();
        assert_eq!(v, json!({"pitchData": [], "onsets": [], "dynamics": []}));
        assert!(!sidecar_was_spawned(&state));
    }

    #[test]
    fn load_analysis_returns_a_current_cached_spectrum_untouched_and_never_spawns_the_sidecar() {
        let _home = TestHome::new();
        let state = offline_state();
        let analysis = json!({
            "pitchData": {"times": [0.0]}, "onsets": [1.0], "dynamics": [],
            "stSpectrumB64": "AAAA", "stSpectrumMinDb": -100.0, "stSpectrumMaxDb": 0.0, "stSpectrumBins": ST_SPECTRUM_MIN_BINS,
        });
        std::fs::write(storage::song_dir("s").join("analysis.json"), analysis.to_string()).unwrap();
        let v = load_analysis_impl(&state, "s").unwrap();
        assert_eq!(v, analysis);
        assert!(!sidecar_was_spawned(&state));
    }

    #[test]
    fn load_analysis_skips_the_backfill_when_there_is_no_vocals_file_to_analyse() {
        let _home = TestHome::new();
        let state = offline_state();
        let analysis = json!({"pitchData": {"times": []}, "onsets": [], "dynamics": []});
        std::fs::write(storage::song_dir("s").join("analysis.json"), analysis.to_string()).unwrap();
        let v = load_analysis_impl(&state, "s").unwrap();
        assert_eq!(v, analysis);
        assert!(!sidecar_was_spawned(&state));
    }

    #[test]
    fn load_analysis_rejects_a_corrupt_analysis_file() {
        let _home = TestHome::new();
        let state = offline_state();
        std::fs::write(storage::song_dir("s").join("analysis.json"), "{{").unwrap();
        assert!(load_analysis_impl(&state, "s").unwrap_err().contains("Parse analysis"));
    }

    #[test]
    fn list_takes_leaves_current_and_unbackfillable_takes_alone() {
        let _home = TestHome::new();
        let state = offline_state();
        let current = with_spectrum(take("current"), ST_SPECTRUM_MIN_BINS);
        let mut orphan = take("orphan");
        orphan.filepath = "/file/was/deleted.wav".into();
        write_takes("s1", &[current, orphan]);

        let listed = list_takes_impl(&state, "s1").unwrap();

        assert_eq!(listed.len(), 2);
        assert!(!sidecar_was_spawned(&state), "nothing to backfill, so no sidecar");
        assert!(listed[1].st_spectrum_b64.is_none());
    }
}
