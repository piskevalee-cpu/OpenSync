mod common;

use common::MockOpenSyncServer;
use launcher_core::{CoreError, LauncherCore, LauncherPaths};
use launcher_db::{GameEnvVar, LauncherDb, MemorySecretStore};
use opensync_runner::LaunchOptions;
use opensync_transfer::DownloadControl;
use std::fs;
use std::sync::Arc;
use std::time::Duration;
use tempfile::tempdir;

fn test_core(dir: &std::path::Path) -> LauncherCore {
    let db = LauncherDb::open_in_memory().unwrap();
    LauncherCore::new(db, MemorySecretStore::new(), LauncherPaths::under(dir))
}

#[tokio::test]
async fn launch_config_can_be_saved_before_install_and_is_validated() {
    let dir = tempdir().unwrap();
    let core = test_core(dir.path());
    let srv = MockOpenSyncServer::start().await;
    srv.add_user(1, "valerio", "secret123");
    srv.add_game(
        31,
        "Configurable",
        "configurable",
        vec![("run.sh", b"#!/bin/sh\nexit 0\n".to_vec())],
    );
    core.connect_with_password("LAN", &srv.base_url, "valerio", "secret123")
        .await
        .unwrap();

    let profile_id = core.active_profile().await.unwrap().id;

    // The game is in the library but has not been downloaded yet.
    core.set_game_launch_config(
        31,
        Some("~/prefixes/configurable".to_string()),
        Some("--windowed --save-dir=\"my saves\"".to_string()),
        vec![GameEnvVar {
            key: "DXVK_HUD".to_string(),
            value: "full".to_string(),
        }],
    )
    .await
    .unwrap();

    let saved = core
        .db()
        .get_game_launch_config(&profile_id, 31)
        .unwrap()
        .expect("config should be saved before install");
    assert!(
        saved
            .wine_prefix
            .unwrap()
            .ends_with("prefixes/configurable")
    );
    assert_eq!(
        saved.launch_args.as_deref(),
        Some("--windowed --save-dir=\"my saves\"")
    );
    assert_eq!(saved.env_vars.len(), 1);
    assert!(
        core.db()
            .get_installed_game(&profile_id, 31)
            .unwrap()
            .is_none()
    );

    let err = core
        .set_game_launch_config(
            31,
            None,
            None,
            vec![GameEnvVar {
                key: "1BAD".to_string(),
                value: "x".to_string(),
            }],
        )
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::InvalidLaunchOption(_)), "{err:?}");
}

#[cfg(unix)]
#[tokio::test]
async fn launch_applies_args_env_and_captures_output() {
    let dir = tempdir().unwrap();
    let core = Arc::new(test_core(dir.path()));
    let srv = MockOpenSyncServer::start().await;
    srv.add_user(1, "valerio", "secret123");
    srv.add_game(
        31,
        "Configurable",
        "configurable",
        vec![(
            "run.sh",
            b"#!/bin/sh\nprintf '%s\\n' \"$@\" > launch-args.txt\nprintf '%s\\n' \"$OPENSYNC_TEST_VAR\" > env-value.txt\necho STDOUT_MARKER\necho STDERR_MARKER >&2\n".to_vec(),
        )],
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
    core.set_game_launch_config(
        31,
        None,
        Some("--flag --name=\"Two Words\"".to_string()),
        vec![GameEnvVar {
            key: "OPENSYNC_TEST_VAR".to_string(),
            value: "from-config".to_string(),
        }],
    )
    .await
    .unwrap();

    core.launch_game(
        31,
        LaunchOptions {
            auto_sync_on_close: false,
            sync_settle_delay: Duration::ZERO,
            heartbeat_interval: Duration::from_millis(50),
            ..LaunchOptions::default()
        },
    )
    .await
    .unwrap();

    let profile_id = core.active_profile().await.unwrap().id;
    let install_dir = core
        .db()
        .get_installed_game(&profile_id, 31)
        .unwrap()
        .unwrap()
        .install_dir;
    let args = fs::read_to_string(install_dir.join("launch-args.txt")).unwrap();
    assert_eq!(args, "--flag\n--name=Two Words\n");
    let env_value = fs::read_to_string(install_dir.join("env-value.txt")).unwrap();
    assert_eq!(env_value.trim(), "from-config");

    let log = core
        .read_game_log(31, 64 * 1024)
        .unwrap()
        .expect("a game log should exist after launch");
    assert!(log.contains("STDOUT_MARKER"), "{log}");
    assert!(log.contains("STDERR_MARKER"), "{log}");
}
