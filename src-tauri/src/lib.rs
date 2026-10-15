mod commands;
mod library;
mod lyrics;
mod pitch;
mod sidecar;
mod storage;
mod windows;
mod youtube_signin;
#[cfg(test)]
mod integration_tests;
#[cfg(test)]
mod test_util;

use commands::SidecarState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let handler: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync> = Box::new(tauri::generate_handler![
        commands::process_song,
        commands::import_youtube,
        commands::export_stem,
        commands::export_all,
        commands::export_take,
        commands::export_mix,
        commands::export_pack,
        commands::pitch_shift_song,
        commands::list_songs,
        commands::delete_song,
        commands::set_metronome_offset,
        commands::rename_song,
        commands::set_song_identity,
        commands::set_song_loops,
        commands::list_folders,
        commands::create_folder,
        commands::rename_folder,
        commands::delete_folder,
        commands::reorder_folders,
        commands::move_songs,
        commands::save_take,
        commands::list_takes,
        commands::delete_take,
        commands::rename_take,
        commands::set_take_manual_offset,
        commands::load_analysis,
        commands::load_lyrics,
        commands::sync_lyrics,
        commands::cancel_lyrics_sync,
        commands::find_lyrics,
        commands::search_lyrics,
        commands::delete_lyrics,
        commands::save_exercise_take,
        commands::import_exercise_file,
        commands::list_exercise_takes,
        commands::delete_exercise_take,
        windows::detach_panel,
        windows::dock_panel,
        windows::close_detached_panel,
        windows::cursor_over_main,
        windows::close_detached_windows,
        youtube_signin::sign_in_youtube,
        youtube_signin::sign_out_youtube,
    ]);
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_updater::Builder::new()
                // Versioning moved from 0.1.x to 0.0.x, which semver orders as older.
                .default_version_comparator(|current, update| update.version != current)
                .build(),
        )
        .manage(SidecarState(std::sync::Mutex::new(None)))
        .manage(windows::WindowMemory::load())
        .invoke_handler(move |invoke| {
            // The sign-in window shows Google's pages; none of this app's commands are open to it.
            if !mps_youtube_signin::may_invoke(invoke.message.webview().label()) {
                invoke.resolver.reject("This window may not call the app's commands");
                return true;
            }
            handler(invoke)
        })
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // Panels detached from the main window must not outlive it.
            if let Some(main) = tauri::Manager::get_webview_window(app, "main") {
                let handle = app.handle().clone();
                main.on_window_event(move |event| {
                    if matches!(event, tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed) {
                        windows::close_all(&handle);
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
