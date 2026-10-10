//! Detached panels: a panel dragged out of the main window gets a window of its
//! own. The window only ever loads this app's own page; what it shows is decided
//! from its label by the frontend, so nothing from a caller is put in a URL.

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

pub const DETACHED_PREFIX: &str = "detached-";
const EVT_DOCKED: &str = "mps:docked";
/// Far beyond any real desktop; a value outside this is a bug or an attack, not a position.
const MAX_COORDINATE: f64 = 20_000.0;

#[derive(Debug, PartialEq)]
pub struct WindowPlan {
    pub label: String,
    pub title: &'static str,
    pub width: f64,
    pub height: f64,
}

/// Mirrors `DETACHABLE_PANELS` in src/windows/protocol.ts.
pub fn plan(panel_id: &str) -> Result<WindowPlan, String> {
    let (title, width, height) = match panel_id {
        "pianoRoll" => ("Piano roll", 1000.0, 460.0),
        "lyrics" => ("Lyrics", 560.0, 640.0),
        other => return Err(format!("{other:?} cannot be detached")),
    };
    Ok(WindowPlan {
        label: format!("{DETACHED_PREFIX}{panel_id}"),
        title,
        width,
        height,
    })
}

pub fn checked_position(x: f64, y: f64) -> Result<(f64, f64), String> {
    if x.is_finite() && y.is_finite() && x.abs() <= MAX_COORDINATE && y.abs() <= MAX_COORDINATE {
        Ok((x, y))
    } else {
        Err(format!("Window position ({x}, {y}) is not on any screen"))
    }
}

pub fn is_detached_label(label: &str) -> bool {
    label.strip_prefix(DETACHED_PREFIX).is_some_and(|rest| plan(rest).is_ok())
}

pub fn close_all(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if is_detached_label(&label) {
            if let Err(e) = window.destroy() {
                log::warn!("Could not close the detached window {label}: {e}");
            }
        }
    }
}

#[tauri::command]
pub async fn detach_panel(app: AppHandle, panel_id: String, x: f64, y: f64) -> Result<(), String> {
    let plan = plan(&panel_id)?;
    let (x, y) = checked_position(x, y)?;

    if let Some(existing) = app.get_webview_window(&plan.label) {
        return existing.set_focus().map_err(|e| format!("Focus {}: {e}", plan.label));
    }

    let window = WebviewWindowBuilder::new(&app, &plan.label, WebviewUrl::App("index.html".into()))
        .title(plan.title)
        .inner_size(plan.width, plan.height)
        .position(x, y)
        .build()
        .map_err(|e| format!("Open {}: {e}", plan.label))?;

    let handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            if let Err(e) = handle.emit(EVT_DOCKED, &panel_id) {
                log::warn!("Could not announce that {panel_id} was docked: {e}");
            }
        }
    });
    Ok(())
}

/// Closes the window that asked, which docks its panel again in the main window.
#[tauri::command]
pub async fn dock_panel(window: WebviewWindow) -> Result<(), String> {
    if !is_detached_label(window.label()) {
        return Err(format!("{} is not a detached panel", window.label()));
    }
    window.close().map_err(|e| format!("Close {}: {e}", window.label()))
}

#[tauri::command]
pub async fn close_detached_windows(app: AppHandle) -> Result<(), String> {
    close_all(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_a_window_for_each_detachable_panel() {
        let p = plan("pianoRoll").unwrap();
        assert_eq!(p.label, "detached-pianoRoll");
        assert!(p.width > 0.0 && p.height > 0.0);
        assert_eq!(plan("lyrics").unwrap().label, "detached-lyrics");
    }

    #[test]
    fn refuses_anything_else_so_a_caller_cannot_choose_a_label() {
        for bad in ["", "takes", "main", "PianoRoll", "pianoRoll ", "../main", "pianoRoll/../x", "detached-pianoRoll"] {
            assert!(plan(bad).is_err(), "{bad:?} must not be detachable");
        }
    }

    #[test]
    fn only_our_own_labels_count_as_detached() {
        assert!(is_detached_label("detached-pianoRoll"));
        assert!(is_detached_label("detached-lyrics"));
        for other in ["main", "detached-", "detached-takes", "xdetached-lyrics", "detached-lyrics-2"] {
            assert!(!is_detached_label(other), "{other:?}");
        }
    }

    #[test]
    fn accepts_positions_on_any_realistic_desktop_including_negative_ones() {
        assert_eq!(checked_position(0.0, 0.0), Ok((0.0, 0.0)));
        assert_eq!(checked_position(-1920.0, 40.0), Ok((-1920.0, 40.0)));
        assert_eq!(checked_position(3840.0, 2160.0), Ok((3840.0, 2160.0)));
    }

    #[test]
    fn rejects_positions_that_are_not_on_a_screen() {
        for (x, y) in [(f64::NAN, 0.0), (0.0, f64::INFINITY), (1e9, 0.0), (0.0, -1e9)] {
            assert!(checked_position(x, y).is_err(), "({x}, {y})");
        }
    }
}
