mod common;

use common::MockOpenSyncServer;
use launcher_core::{LauncherCore, LauncherEvent, LauncherPaths};
use launcher_db::{LauncherDb, MemorySecretStore};
use opensync_runner::LaunchOptions;
use opensync_transfer::DownloadControl;
use std::fs;
use std::sync::Arc;
use std::time::Duration;
use tempfile::tempdir;

#[tokio::test]
async fn post_close_auto_sync_emits_lifecycle_events_and_records_activity_logs() {
    let dir = tempdir().unwrap();
    let db = LauncherDb::open_in_memory().unwrap();
    let secrets = MemorySecretStore::new();
    let core = LauncherCore::new(db, secrets, LauncherPaths::under(dir.path()));

    let srv = MockOpenSyncServer::start().await;
    srv.add_user(1, "valerio", "secret123");
    srv.add_game(
        31,
        "ChronoBlade",
        "chrono-blade",
        vec![
            (
                "run.sh",
                b"#!/bin/sh\necho 'chapter-2' > saves/progress.sav\n".to_vec(),
            ),
            ("saves/progress.sav", b"chapter-1".to_vec()),
        ],
    );

    core.connect_with_password("LAN", &srv.base_url, "valerio", "secret123")
        .await
        .unwrap();
    core.download_game(31, true, DownloadControl::new(0, 0))
        .await
        .unwrap();
    core.set_game_executable(31, Some("run.sh".to_string()))
        .await
        .unwrap();

    let mut rx = core.subscribe_events();
    let outcome = core
        .launch_game(
            31,
            LaunchOptions {
                auto_sync_on_close: true,
                sync_settle_delay: Duration::ZERO,
                heartbeat_interval: Duration::from_millis(50),
                extra_args: vec![],
                prefixes_root: dir.path().join("prefixes"),
                ..LaunchOptions::default()
            },
        )
        .await
        .unwrap();

    assert!(outcome.session.synced);
    assert_eq!(
        srv.overlay_files(1, 31).get("saves/progress.sav").unwrap(),
        b"chapter-2\n"
    );

    let mut saw_session_started = false;
    let mut saw_sync_started = false;
    let mut saw_sync_completed = false;
    let mut saw_session_ended = false;
    let mut activity_kinds = Vec::new();

    while let Ok(evt) = rx.try_recv() {
        match evt {
            LauncherEvent::GameSessionStarted { game_id, name } => {
                assert_eq!(game_id, 31);
                assert_eq!(name, "ChronoBlade");
                saw_session_started = true;
            }
            LauncherEvent::GameSyncStarted {
                game_id, trigger, ..
            } => {
                assert_eq!(game_id, 31);
                assert_eq!(trigger, "post_exit");
                saw_sync_started = true;
            }
            LauncherEvent::GameSyncCompleted {
                game_id,
                trigger,
                uploaded_files,
                ..
            } => {
                assert_eq!(game_id, 31);
                assert_eq!(trigger, "post_exit");
                assert_eq!(uploaded_files, 1);
                saw_sync_completed = true;
            }
            LauncherEvent::GameSessionEnded {
                game_id,
                synced,
                uploaded_files,
                ..
            } => {
                assert_eq!(game_id, 31);
                assert!(synced);
                assert_eq!(uploaded_files, 1);
                saw_session_ended = true;
            }
            LauncherEvent::ActivityLogged { entry } => {
                activity_kinds.push(entry.kind);
            }
            _ => {}
        }
    }

    assert!(saw_session_started, "expected GameSessionStarted");
    assert!(saw_sync_started, "expected GameSyncStarted on game exit");
    assert!(saw_sync_completed, "expected GameSyncCompleted");
    assert!(saw_session_ended, "expected GameSessionEnded");
    assert!(activity_kinds.contains(&"game_start".to_string()));
    assert!(activity_kinds.contains(&"game_close".to_string()));
    assert!(activity_kinds.contains(&"sync_complete".to_string()));

    let logs = core.list_activity_logs(20).await.unwrap();
    assert!(logs.len() >= 3);
}

#[tokio::test]
async fn force_quit_while_playing_is_detected_on_next_startup_and_offers_save_sync() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("launcher.db");
    let secrets = MemorySecretStore::new();

    let srv = MockOpenSyncServer::start().await;
    srv.add_user(1, "valerio", "secret123");
    srv.add_game(
        32,
        "Starlight",
        "starlight",
        vec![
            ("game.bin", b"elf".to_vec()),
            ("saves/slot1.sav", b"initial".to_vec()),
        ],
    );
    srv.add_game(
        33,
        "UntouchedGame",
        "untouched-game",
        vec![("game.bin", b"elf".to_vec())],
    );

    let install_dir_32 = {
        let db = LauncherDb::open(&db_path).unwrap();
        let core = LauncherCore::new(
            db,
            Arc::clone(&secrets) as Arc<dyn launcher_db::SecretStore>,
            LauncherPaths::under(dir.path()),
        );
        let profile = core
            .connect_with_password("LAN", &srv.base_url, "valerio", "secret123")
            .await
            .unwrap();
        let (inst32, _) = core
            .download_game(32, true, DownloadControl::new(0, 0))
            .await
            .unwrap();
        let (_inst33, _) = core
            .download_game(33, true, DownloadControl::new(0, 0))
            .await
            .unwrap();

        // Simulate both games running when the launcher is force-quit (dropped without
        // calling mark_game_stopped). Game 32 writes new save data; Game 33 has no save edits.
        core.mark_game_playing(&profile.id, 32);
        core.mark_game_playing(&profile.id, 33);
        fs::write(inst32.install_dir.join("saves/slot1.sav"), b"boss defeated").unwrap();
        fs::write(inst32.install_dir.join("saves/slot2.sav"), b"new slot").unwrap();
        inst32.install_dir
    };

    // Next startup: create a fresh LauncherCore against the same SQLite database.
    let db2 = LauncherDb::open(&db_path).unwrap();
    let core2 = LauncherCore::new(
        db2,
        Arc::clone(&secrets) as Arc<dyn launcher_db::SecretStore>,
        LauncherPaths::under(dir.path()),
    );
    core2.restore_remembered_profile().await.unwrap();

    let interrupted = core2.detect_interrupted_sessions().await.unwrap();
    // Game 33 had no unsynced save changes so it was auto-recovered cleanly; Game 32 has
    // 2 modified save files so it is surfaced to offer a save sync to the user.
    assert_eq!(interrupted.len(), 1);
    assert_eq!(interrupted[0].game_id, 32);
    assert_eq!(interrupted[0].game_name, "Starlight");
    assert!(interrupted[0].has_unsynced_saves);
    assert_eq!(interrupted[0].changed_files, 2);
    assert!(interrupted[0]
        .sample_paths
        .iter()
        .any(|p| p == "saves/slot1.sav"));

    // While awaiting the user's decision, background auto-sync must not touch Game 32.
    let bg = core2.run_background_auto_sync_once().await.unwrap();
    assert_eq!(bg.synced_games, 1, "only UntouchedGame should background-sync");
    assert!(srv.overlay_files(1, 32).is_empty());

    // User accepts the offer to sync saves from the interrupted session.
    let report = core2
        .resolve_interrupted_session(32, true, false)
        .await
        .unwrap()
        .expect("expected SyncReport when sync_saves = true");
    assert_eq!(report.uploaded_files, 2);
    assert_eq!(
        srv.overlay_files(1, 32).get("saves/slot1.sav").unwrap(),
        b"boss defeated"
    );
    assert_eq!(
        srv.overlay_files(1, 32).get("saves/slot2.sav").unwrap(),
        b"new slot"
    );
    assert!(
        core2
            .detect_interrupted_sessions()
            .await
            .unwrap()
            .is_empty(),
        "interrupted session should be cleared after resolution"
    );
    let _ = install_dir_32;
}

#[tokio::test]
async fn safe_shutdown_guards_playing_games_waits_for_active_syncs_and_checkpoints_wal() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("launcher.db");
    let db = LauncherDb::open(&db_path).unwrap();
    let secrets = MemorySecretStore::new();
    let core = Arc::new(LauncherCore::new(
        db,
        secrets,
        LauncherPaths::under(dir.path()),
    ));

    let srv = MockOpenSyncServer::start().await;
    srv.add_user(1, "valerio", "secret123");
    srv.add_game(
        34,
        "SafeExitQuest",
        "safe-exit-quest",
        vec![("game.bin", b"elf".to_vec())],
    );

    let profile = core
        .connect_with_password("LAN", &srv.base_url, "valerio", "secret123")
        .await
        .unwrap();
    core.download_game(34, true, DownloadControl::new(0, 0))
        .await
        .unwrap();

    // 1. When a game is playing and force_while_playing == false, safe shutdown blocks and
    // reports the running game so the UI can warn the user.
    core.mark_game_playing(&profile.id, 34);
    let blocked = core
        .perform_safe_shutdown(Duration::from_secs(1), false)
        .await
        .unwrap();
    assert!(!blocked.completed);
    assert_eq!(blocked.playing_games, vec!["SafeExitQuest".to_string()]);
    assert!(!core.is_shutting_down());
    core.mark_game_stopped(&profile.id, 34);

    // 2. When a save sync is actively in flight, perform_safe_shutdown waits for it to finish
    // before checkpointing SQLite WAL and completing.
    let guard = core.begin_sync_activity();
    assert_eq!(core.active_sync_count(), 1);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(120)).await;
        drop(guard);
    });

    let done = core
        .perform_safe_shutdown(Duration::from_secs(3), false)
        .await
        .unwrap();
    assert!(done.completed);
    assert_eq!(done.active_syncs_remaining, 0);
    assert!(done.wal_checkpointed);
    assert!(core.is_shutting_down());
}
