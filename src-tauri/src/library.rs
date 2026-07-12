use crate::storage;
use serde::{Deserialize, Serialize};
use std::fs;

/// Song metadata persisted in library.json.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Song {
    pub id: String,
    pub title: String,
    pub artist: Option<String>,
    pub duration: f64,
    pub detected_key: Option<String>,
    pub detected_bpm: Option<f64>,
    pub processed_at: String,
    pub directory: String,
    #[serde(default = "default_song_kind")]
    pub kind: String, // "vocal" | "instrument"
    // Song time (s) where the metronome's beat 1 lands — lets the user align
    // the click track to the song's actual downbeat when there's silence (or
    // a pickup) before it, instead of always starting at song position 0.
    #[serde(default)]
    pub metronome_offset: Option<f64>,
}

fn default_song_kind() -> String {
    "vocal".to_string()
}

fn library_path() -> std::path::PathBuf {
    storage::app_data_dir().join("library.json")
}

/// Load all songs from library.json.
pub fn load() -> Result<Vec<Song>, String> {
    let path = library_path();
    if !path.exists() {
        return Ok(vec![]);
    }
    let data = fs::read_to_string(&path).map_err(|e| format!("Read library: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("Parse library: {e}"))
}

/// Save songs to library.json.
fn save(songs: &[Song]) -> Result<(), String> {
    let path = library_path();
    let data = serde_json::to_string_pretty(songs).map_err(|e| format!("Serialize: {e}"))?;
    fs::write(&path, data).map_err(|e| format!("Write library: {e}"))
}

/// Add a song to the library.
pub fn add(song: Song) -> Result<(), String> {
    let mut songs = load()?;
    songs.push(song);
    save(&songs)
}

/// Update a song's metronome downbeat offset and persist it.
pub fn update_metronome_offset(song_id: &str, offset: Option<f64>) -> Result<Song, String> {
    let mut songs = load()?;
    let song = songs
        .iter_mut()
        .find(|s| s.id == song_id)
        .ok_or_else(|| format!("Song not found: {song_id}"))?;
    song.metronome_offset = offset;
    let updated = song.clone();
    save(&songs)?;
    Ok(updated)
}

/// Find `song_id` in `songs` and set its title to the trimmed `title`.
/// Pulled out of `rename` so the find/trim/mutate logic is unit-testable
/// without touching the real library.json on disk.
fn rename_in(songs: &mut [Song], song_id: &str, title: &str) -> Result<Song, String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err("Song title cannot be empty".to_string());
    }
    let song = songs
        .iter_mut()
        .find(|s| s.id == song_id)
        .ok_or_else(|| format!("Song not found: {song_id}"))?;
    song.title = trimmed.to_string();
    Ok(song.clone())
}

/// Rename a song and persist it. Unlike take names, a song has no
/// placeholder fallback to revert to, so an empty/whitespace title is
/// rejected rather than silently cleared.
pub fn rename(song_id: &str, title: &str) -> Result<Song, String> {
    let mut songs = load()?;
    let updated = rename_in(&mut songs, song_id, title)?;
    save(&songs)?;
    Ok(updated)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn song(id: &str, title: &str) -> Song {
        Song {
            id: id.to_string(),
            title: title.to_string(),
            artist: None,
            duration: 0.0,
            detected_key: None,
            detected_bpm: None,
            processed_at: String::new(),
            directory: String::new(),
            kind: "vocal".to_string(),
            metronome_offset: None,
        }
    }

    #[test]
    fn renames_matching_song_and_trims_whitespace() {
        let mut songs = vec![song("a", "Old Title"), song("b", "Other Song")];
        let updated = rename_in(&mut songs, "a", "  New Title  ").unwrap();
        assert_eq!(updated.title, "New Title");
        assert_eq!(songs[0].title, "New Title");
        assert_eq!(songs[1].title, "Other Song"); // untouched
    }

    #[test]
    fn rejects_empty_or_whitespace_title() {
        let mut songs = vec![song("a", "Old Title")];
        assert!(rename_in(&mut songs, "a", "   ").is_err());
        assert_eq!(songs[0].title, "Old Title"); // unchanged on rejection
    }

    #[test]
    fn errors_on_unknown_song_id() {
        let mut songs = vec![song("a", "Old Title")];
        assert!(rename_in(&mut songs, "missing-id", "New Title").is_err());
    }
}

/// Remove a song from the library and delete its directory.
pub fn remove(song_id: &str) -> Result<(), String> {
    let songs = load()?;
    let to_remove = songs.iter().find(|s| s.id == song_id);
    if let Some(song) = to_remove {
        let dir = std::path::Path::new(&song.directory);
        if dir.exists() {
            fs::remove_dir_all(dir).map_err(|e| format!("Delete dir: {e}"))?;
        }
    }
    let filtered: Vec<Song> = songs.into_iter().filter(|s| s.id != song_id).collect();
    save(&filtered)
}
