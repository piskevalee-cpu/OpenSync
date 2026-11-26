#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

use commands::AppState;
use launcher_core::{LauncherCore, LauncherPaths, default_data_dir, default_games_dir};
use launcher_db::{FileSecretStore, LauncherDb};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager};
use tokio::sync::broadcast::error::RecvError;

/// Resolves the launcher data root. On macOS this is
/// `~/Library/Application Support/opensync-launcher`; other platforms keep their XDG or
/// Windows locations. The logic lives in `launcher-db` so it is shared and testable.
fn resolve_data_root() -> PathBuf {
    default_data_dir()
}

#[derive(Clone, serde::Serialize)]
struct DragDropPayload {
    kind: &'static str,
    paths: Vec<String>,
    x: f64,
    y: f64,
}

fn emit_drag_drop(window: &tauri::Window, payload: DragDropPayload) {
    if let Err(err) = window.emit("launcher-drag-drop", payload) {
        tracing::warn!(error = %err, "failed to emit launcher-drag-drop");
    }
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let data_root = resolve_data_root();
    if let Err(err) = std::fs::create_dir_all(&data_root) {
        tracing::error!(path = %data_root.display(), error = %err, "failed to create launcher data directory");
    }

    let db = match LauncherDb::open(data_root.join("launcher.db")) {
        Ok(db) => db,
        Err(err) => {
            tracing::error!(path = %data_root.display(), error = %err, "failed to initialize launcher SQLite database");
            std::process::exit(1);
        }
    };
    let secrets = FileSecretStore::new(data_root.join("secrets.json"));

    // Games are installed into a dedicated `Games/OpenSync` folder, overridable from
    // Settings or the OPENSYNC_LAUNCHER_GAMES_DIR env var.
    let games_dir = if let Ok(custom) = std::env::var("OPENSYNC_LAUNCHER_GAMES_DIR")
        && !custom.trim().is_empty()
    {
        PathBuf::from(custom)
    } else if let Some(saved) = db.get_setting("games_dir").ok().flatten()
        && !saved.trim().is_empty()
    {
        PathBuf::from(saved)
    } else {
        default_games_dir()
    };
    if let Err(err) = std::fs::create_dir_all(&games_dir) {
        tracing::error!(path = %games_dir.display(), error = %err, "failed to create games directory");
    }

    let mut paths = LauncherPaths::under(&data_root);
    paths.library_root = games_dir;
    let core = Arc::new(LauncherCore::new(db, secrets, paths));
    let app_state = AppState::new(Arc::clone(&core));

    tauri::Builder::default()
        .manage(app_state)
        .setup(move |app| {
            if let (Some(icon), Some(win)) = (
                app.default_window_icon().cloned(),
                app.get_webview_window("main"),
            ) {
                let _ = win.set_icon(icon);
            }
            let app_handle = app.handle().clone();
            let state = app.state::<AppState>();
            let core_for_events = Arc::clone(&state.core);
            let core_for_restore = Arc::clone(&state.core);
            let core_for_auto_sync = Arc::clone(&state.core);

            let mut rx = core_for_events.subscribe_events();
            tauri::async_runtime::spawn(async move {
                loop {
                    match rx.recv().await {
                        Ok(evt) => {
                            if let Err(err) = app_handle.emit("launcher-event", &evt) {
                                tracing::warn!(error = %err, "failed to emit launcher-event");
                            }
                        }
                        Err(RecvError::Lagged(skipped)) => {
                            tracing::debug!(skipped, "launcher event receiver lagged");
                        }
                        Err(RecvError::Closed) => break,
                    }
                }
            });

            tauri::async_runtime::spawn(async move {
                if let Err(err) = core_for_restore.restore_remembered_profile().await {
                    tracing::warn!(error = %err, "failed to restore remembered profile");
                }
            });

            // Background differential save sync every 30s: defer the initial pass by 5s so
            // background scanning does not compete with cold boot / UI hydration.
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(5)).await;
                let _handle =
                    core_for_auto_sync.spawn_background_auto_sync(Duration::from_secs(30));
            });

            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                let state = window.state::<AppState>();
                if state
                    .allow_window_close
                    .load(std::sync::atomic::Ordering::SeqCst)
                {
                    return;
                }
                let status = state.core.shutdown_status();
                if status.ready_to_exit {
                    let _ = state.core.db().checkpoint_wal();
                    state
                        .allow_window_close
                        .store(true, std::sync::atomic::Ordering::SeqCst);
                } else {
                    api.prevent_close();
                    state.core.request_shutdown_check();
                }
            }
            tauri::WindowEvent::DragDrop(ev) => match ev {
                tauri::DragDropEvent::Enter { paths, position } => emit_drag_drop(
                    window,
                    DragDropPayload {
                        kind: "enter",
                        paths: paths
                            .iter()
                            .map(|p| p.to_string_lossy().into_owned())
                            .collect(),
                        x: position.x,
                        y: position.y,
                    },
                ),
                tauri::DragDropEvent::Over { position } => emit_drag_drop(
                    window,
                    DragDropPayload {
                        kind: "over",
                        paths: Vec::new(),
                        x: position.x,
                        y: position.y,
                    },
                ),
                tauri::DragDropEvent::Drop { paths, position } => emit_drag_drop(
                    window,
                    DragDropPayload {
                        kind: "drop",
                        paths: paths
                            .iter()
                            .map(|p| p.to_string_lossy().into_owned())
                            .collect(),
                        x: position.x,
                        y: position.y,
                    },
                ),
                tauri::DragDropEvent::Leave => emit_drag_drop(
                    window,
                    DragDropPayload {
                        kind: "leave",
                        paths: Vec::new(),
                        x: 0.0,
                        y: 0.0,
                    },
                ),
                _ => {}
            },
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_bootstrap_state,
            commands::get_games_dir,
            commands::set_games_dir,
            commands::connect_profile,
            commands::switch_profile,
            commands::delete_profile,
            commands::get_current_user_profile,
            commands::get_user_pfp_data_url,
            commands::upload_profile_pfp,
            commands::remove_profile_pfp,
            commands::delete_server_account,
            commands::rename_profile,
            commands::reconnect_now,
            commands::list_library,
            commands::get_game_cover_data_url,
            commands::start_game_download,
            commands::pause_download,
            commands::resume_download,
            commands::cancel_download,
            commands::set_bandwidth_limit,
            commands::list_downloads,
            commands::launch_game,
            commands::sync_game_now,
            commands::uninstall_game,
            commands::set_game_executable,
            commands::set_game_proton,
            commands::set_game_launch_config,
            commands::list_proton_installations,
            commands::fetch_latest_ge_proton,
            commands::download_ge_proton,
            commands::change_username,
            commands::pick_upload_folder,
            commands::pick_wine_prefix_dir,
            commands::scan_upload_folder,
            commands::inspect_dropped_paths,
            commands::read_local_image,
            commands::start_game_upload,
            commands::upload_game_chunk,
            commands::finalize_dropped_upload,
            commands::pause_upload,
            commands::resume_upload,
            commands::cancel_upload,
            commands::list_uploads,
            commands::list_activity_logs,
            commands::clear_activity_logs,
            commands::get_game_log,
            commands::clear_game_log,
            commands::list_interrupted_sessions,
            commands::resolve_interrupted_session,
            commands::get_shutdown_status,
            commands::confirm_safe_shutdown,
        ])
        .run(tauri::generate_context!())
        .expect("error while running OpenSync Launcher");
}
