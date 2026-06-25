use std::fs;
use std::path::PathBuf;

/// Root data directory: ~/.vps/
pub fn app_data_dir() -> PathBuf {
    let base = dirs::home_dir().expect("could not determine home directory");
    let dir = base.join(".vps");
    fs::create_dir_all(&dir).expect("could not create app data dir");
    dir
}

/// Library directory: ~/.vps/library/
pub fn library_dir() -> PathBuf {
    let dir = app_data_dir().join("library");
    fs::create_dir_all(&dir).expect("could not create library dir");
    dir
}

/// Per-song directory: ~/.vps/library/{song_id}/
pub fn song_dir(song_id: &str) -> PathBuf {
    let dir = library_dir().join(song_id);
    fs::create_dir_all(&dir).expect("could not create song dir");
    dir
}

/// Exercises directory: ~/.vps/exercises/
pub fn exercises_dir() -> PathBuf {
    let dir = app_data_dir().join("exercises");
    fs::create_dir_all(&dir).expect("could not create exercises dir");
    dir
}

/// Exercises takes directory: ~/.vps/exercises/takes/
pub fn exercises_takes_dir() -> PathBuf {
    let dir = exercises_dir().join("takes");
    fs::create_dir_all(&dir).expect("could not create exercises takes dir");
    dir
}
