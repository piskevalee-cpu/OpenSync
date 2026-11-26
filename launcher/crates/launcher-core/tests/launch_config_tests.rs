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
    let returned = core
        .set_game_launch_config(
            31,
            Some("~/prefixes/configurable".to_string()),
            Some("--windowed --save-dir=\"my saves\"".to_string()),
            vec![GameEnvVar {
                key: "DXVK_HUD".to_string(),
                value: " full ".to_string(),
            }],
        )
        .await
        .unwrap();
    assert!(
        returned
            .wine_prefix
            .as_deref()
            .unwrap()
            .ends_with("prefixes/configurable")
    );
    assert_eq!(returned.env_vars[0].value, " full ");

    let saved = core
        .db()
        .get_game_launch_config(&profile_id, 31)
        .unwrap()
        .expect("config should be saved before install");
    assert_eq!(saved, returned);
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

    // Embedded NUL bytes must be explicitly rejected in prefix, args, and env values.
    for (prefix, args, val) in [
        (Some("/tmp/bad\0prefix".to_string()), None, "ok"),
        (None, Some("--bad\0arg".to_string()), "ok"),
        (None, None, "bad\0val"),
    ] {
        let nul_err = core
            .set_game_launch_config(
                31,
                prefix,
                args,
                vec![GameEnvVar {
                    key: "VALID_KEY".to_string(),
                    value: val.to_string(),
                }],
            )
            .await
            .unwrap_err();
        assert!(
            matches!(nul_err, CoreError::InvalidLaunchOption(_)),
            "{nul_err:?}"
        );
    }
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
        .read_game_log(&profile_id, 31, 64 * 1024)
        .unwrap()
        .expect("a game log should exist after launch");
    assert!(log.contains("STDOUT_MARKER"), "{log}");
    assert!(log.contains("STDERR_MARKER"), "{log}");

    // Another profile sharing the same game_id has its own isolated log file.
    assert!(core.read_game_log("other-profile", 31, 64 * 1024).unwrap().is_none());

    core.clear_game_log(&profile_id, 31).unwrap();
    assert!(core.read_game_log(&profile_id, 31, 64 * 1024).unwrap().is_none());
}

#[test]
fn read_game_log_seeks_tail_and_drops_partial_first_line() {
    let dir = tempdir().unwrap();
    let core = test_core(dir.path());
    let log_path = core.game_log_path("prof-a", 99);
    fs::create_dir_all(log_path.parent().unwrap()).unwrap();

    let mut content = String::new();
    for i in 0..2000 {
        content.push_str(&format!("line-{i:04}-payload-text\n"));
    }
    fs::write(&log_path, &content).unwrap();

    let tail = core.read_game_log("prof-a", 99, 256).unwrap().unwrap();
    assert!(tail.len() <= 256, "tail exceeded cap: {}", tail.len());
    assert!(tail.starts_with("line-"), "expected partial line trimmed, got: {tail:?}");
    assert!(tail.contains("line-1999-payload-text"), "{tail}");
}
