mod common;

use common::MockOpenSyncServer;
use flate2::Compression;
use flate2::write::GzEncoder;
use launcher_core::{
    ConnectionState, ConnectionStateDto, CoreError, DownloadKind, DownloadStatus, LauncherCore,
    LauncherEvent, LauncherPaths,
};
use launcher_db::{LauncherDb, MemorySecretStore, SecretStore};
use opensync_proton::{GeProtonRelease, ProtonSource, download_and_install_ge_proton};
use opensync_runner::LaunchOptions;
use sha2::{Digest, Sha512};
use std::fs;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tar::Builder as TarBuilder;
use tempfile::tempdir;
use tokio::sync::broadcast;

fn build_mock_ge_proton_tarball(tag: &str) -> (Vec<u8>, String) {
    let mut gz = GzEncoder::new(Vec::new(), Compression::default());
    {
        let mut tar = TarBuilder::new(&mut gz);

        let proton_script = b"#!/bin/sh\necho \"mock proton running $*\"\n";
        let mut hdr = tar::Header::new_gnu();
        hdr.set_size(proton_script.len() as u64);
        hdr.set_mode(0o755);
        hdr.set_cksum();
        tar.append_data(&mut hdr, format!("{tag}/proton"), &proton_script[..])
            .unwrap();

        let version_txt = format!("1700000000 {tag}\n");
        let mut vhdr = tar::Header::new_gnu();
        vhdr.set_size(version_txt.len() as u64);
        vhdr.set_mode(0o644);
        vhdr.set_cksum();
        tar.append_data(&mut vhdr, format!("{tag}/version"), version_txt.as_bytes())
            .unwrap();

        // Add some padding data so download streaming reports multiple progress callbacks
        let payload = vec![0xABu8; 256 * 1024];
        let mut phdr = tar::Header::new_gnu();
        phdr.set_size(payload.len() as u64);
        phdr.set_mode(0o644);
        phdr.set_cksum();
        tar.append_data(&mut phdr, format!("{tag}/files/lib/mock.bin"), &payload[..])
            .unwrap();

        tar.finish().unwrap();
    }
    let tarball_bytes = gz.finish().unwrap();
    let digest = hex::encode(Sha512::digest(&tarball_bytes));
    let sha512sum_text = format!("{digest}  {tag}.tar.gz\n");
    (tarball_bytes, sha512sum_text)
}

async fn wait_for_download_status(
    rx: &mut broadcast::Receiver<LauncherEvent>,
    job_id: &str,
    pred: impl Fn(&DownloadStatus) -> bool,
) -> launcher_core::DownloadJobSnapshot {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match rx.recv().await {
                Ok(LauncherEvent::DownloadUpdated { job })
                    if job.id == job_id && pred(&job.status) =>
                {
                    return job;
                }
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => {
                    panic!("event channel closed while waiting for download {job_id}")
                }
            }
        }
    })
    .await
    .expect("timed out waiting for expected DownloadUpdated status")
}

#[tokio::test]
async fn download_manager_lifecycle_pause_resume_bandwidth_and_events() {
    let dir = tempdir().unwrap();
    let db = LauncherDb::open_in_memory().unwrap();
    let secrets = MemorySecretStore::new();
    let core = Arc::new(LauncherCore::new(db, secrets, LauncherPaths::under(dir.path())));

    let srv = MockOpenSyncServer::start().await;
    srv.add_user(1, "valerio", "secret123");

    // 1.5 MB payload so throttling/pausing is deterministic and fast
    let big_file = vec![0x5Au8; 1536 * 1024];
    srv.add_game(
        42,
        "Starlight Drift",
        "starlight-drift",
        vec![
            ("drift.sh", b"#!/bin/sh\necho drift\n".to_vec()),
            ("pak/world.pak", big_file.clone()),
        ],
    );

    let mut events = core.subscribe_events();

    core.connect_with_password("LAN", &srv.base_url, "valerio", "secret123")
        .await
        .unwrap();

    // Verify ConnectionChanged(Connected) was emitted
    let conn_evt = tokio::time::timeout(Duration::from_secs(2), events.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        conn_evt,
        LauncherEvent::ConnectionChanged {
            state: ConnectionStateDto::Connected
        }
    ));

    // Apply bandwidth throttle before starting so the download stays active long enough to pause
    core.set_bandwidth_limit(256 * 1024).await;

    let started_at = Instant::now();
    let job_id = core.start_game_download(42, true).await.unwrap();

    // Wait until it transitions to Downloading
    let downloading = wait_for_download_status(&mut events, &job_id, |s| {
        matches!(s, DownloadStatus::Downloading)
    })
    .await;
    assert_eq!(
        downloading.kind,
        DownloadKind::Game {
            game_id: 42,
            fresh: true
        }
    );

    // Pause the active download
    assert!(core.pause_download(&job_id).await);
    let paused = wait_for_download_status(&mut events, &job_id, |s| {
        matches!(s, DownloadStatus::Paused)
    })
    .await;
    assert_eq!(paused.status, DownloadStatus::Paused);

    // Pausing an already-paused job returns false
    assert!(!core.pause_download(&job_id).await);

    // Verify list_downloads reflects Paused
    let listed = core.list_downloads().await;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, job_id);
    assert_eq!(listed[0].status, DownloadStatus::Paused);

    // Keep paused briefly and confirm bytes do not rush ahead
    tokio::time::sleep(Duration::from_millis(80)).await;
    let bytes_paused_1 = core.list_downloads().await[0].bytes_downloaded;
    tokio::time::sleep(Duration::from_millis(80)).await;
    let bytes_paused_2 = core.list_downloads().await[0].bytes_downloaded;
    assert_eq!(bytes_paused_1, bytes_paused_2, "bytes should hold while paused");

    // Resume and lift bandwidth limit so it finishes immediately
    assert!(core.resume_download(&job_id).await);
    let _resumed = wait_for_download_status(&mut events, &job_id, |s| {
        matches!(s, DownloadStatus::Downloading)
    })
    .await;
    core.set_bandwidth_limit(0).await;

    let completed = wait_for_download_status(&mut events, &job_id, |s| {
        matches!(s, DownloadStatus::Completed)
    })
    .await;
    assert_eq!(completed.status, DownloadStatus::Completed);
    assert_eq!(completed.files_extracted, 2);
    assert_eq!(completed.total_files, 2);
    assert!(started_at.elapsed() >= Duration::from_millis(140));

    // Installed game should now be persisted and extracted on disk
    let games = core.list_downloaded_games().await.unwrap();
    assert_eq!(games.len(), 1);
    assert_eq!(games[0].game_id, 42);
    assert_eq!(
        fs::read(games[0].install_dir.join("pak/world.pak")).unwrap(),
        big_file
    );

    // Cannot pause or cancel a completed job
    assert!(!core.pause_download(&job_id).await);
    assert!(!core.cancel_download(&job_id).await);
}

#[tokio::test]
async fn download_manager_cancel_aborts_cleanly_without_installing() {
    let dir = tempdir().unwrap();
    let db = LauncherDb::open_in_memory().unwrap();
    let secrets = MemorySecretStore::new();
    let core = Arc::new(LauncherCore::new(db, secrets, LauncherPaths::under(dir.path())));

    let srv = MockOpenSyncServer::start().await;
    srv.add_user(1, "valerio", "secret123");
    srv.add_game(
        99,
        "CancelQuest",
        "cancel-quest",
        vec![("huge.bin", vec![0x99u8; 2 * 1024 * 1024])],
    );

    core.connect_with_password("LAN", &srv.base_url, "valerio", "secret123")
        .await
        .unwrap();

    let mut events = core.subscribe_events();
    // Throttle tightly so cancel definitely happens mid-stream
    core.set_bandwidth_limit(64 * 1024).await;

    let job_id = core.start_game_download(99, true).await.unwrap();
    let _ = wait_for_download_status(&mut events, &job_id, |s| {
        matches!(s, DownloadStatus::Downloading)
    })
    .await;

    assert!(core.cancel_download(&job_id).await);
    let cancelled = wait_for_download_status(&mut events, &job_id, |s| {
        matches!(s, DownloadStatus::Cancelled)
    })
    .await;
    assert_eq!(cancelled.status, DownloadStatus::Cancelled);

    // Give background task a moment to clean up staging dir
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Game must NOT be installed in DB
    assert!(core.list_downloaded_games().await.unwrap().is_empty());

    // Final list_downloads still reports Cancelled (not overwritten by Failed)
    let listed = core.list_downloads().await;
    assert_eq!(listed[0].status, DownloadStatus::Cancelled);

    // Unknown job ID returns false
    assert!(!core.cancel_download("nonexistent-job").await);
}

#[tokio::test]
async fn ge_proton_http_download_sha512_verify_extract_and_detect() {
    let dir = tempdir().unwrap();
    let db = LauncherDb::open_in_memory().unwrap();
    let secrets = MemorySecretStore::new();
    let paths = LauncherPaths::under(dir.path());
    let core = Arc::new(LauncherCore::new(db, secrets, paths.clone()));

    let srv = MockOpenSyncServer::start().await;
    let tag = "GE-Proton9-99-Test";
    let (tarball, sha512_text) = build_mock_ge_proton_tarball(tag);

    let tarball_path = format!("/releases/{tag}.tar.gz");
    let sha_path = format!("/releases/{tag}.sha512sum");
    let bad_sha_path = format!("/releases/{tag}-bad.sha512sum");

    srv.add_public_file(&tarball_path, tarball.clone(), "application/gzip");
    srv.add_public_file(&sha_path, sha512_text.into_bytes(), "text/plain");
    srv.add_public_file(
        &bad_sha_path,
        format!("{}  {tag}.tar.gz\n", "0".repeat(128)).into_bytes(),
        "text/plain",
    );

    // 1. Corrupt SHA-512 must fail cleanly and clean up temp tarball
    let mut events = core.subscribe_events();
    let bad_release = GeProtonRelease {
        tag_name: format!("{tag}-bad"),
        tarball_url: format!("{}{}", srv.base_url, tarball_path),
        tarball_name: format!("{tag}.tar.gz"),
        tarball_size: tarball.len() as u64,
        sha512_url: Some(format!("{}{}", srv.base_url, bad_sha_path)),
    };
    let bad_job_id = core.start_ge_proton_download(bad_release).await.unwrap();
    let failed = wait_for_download_status(&mut events, &bad_job_id, |s| {
        matches!(s, DownloadStatus::Failed { .. })
    })
    .await;
    match &failed.status {
        DownloadStatus::Failed { error } => {
            assert!(
                error.contains("sha512"),
                "expected sha512 mismatch error, got: {error}"
            );
        }
        other => panic!("expected Failed status, got {other:?}"),
    }
    // Verify no leftover temp .part files in proton_dir
    for entry in fs::read_dir(&paths.proton_dir).unwrap() {
        let name = entry.unwrap().file_name().to_string_lossy().to_string();
        assert!(
            !name.ends_with(".part"),
            "temp tarball should be removed on error: {name}"
        );
    }

    // 2. Valid GE-Proton download + SHA-512 verify + extract via Download Manager
    let good_release = GeProtonRelease {
        tag_name: tag.to_string(),
        tarball_url: format!("{}{}", srv.base_url, tarball_path),
        tarball_name: format!("{tag}.tar.gz"),
        tarball_size: tarball.len() as u64,
        sha512_url: Some(format!("{}{}", srv.base_url, sha_path)),
    };
    let good_job_id = core.start_ge_proton_download(good_release).await.unwrap();

    // Wait for both Completed DownloadUpdated and ProtonInstalled events
    let mut saw_verifying = false;
    let mut saw_completed = false;
    let mut installed_event = None;
    tokio::time::timeout(Duration::from_secs(10), async {
        while !(saw_completed && installed_event.is_some()) {
            match events.recv().await {
                Ok(LauncherEvent::DownloadUpdated { job }) if job.id == good_job_id => {
                    assert_eq!(
                        job.kind,
                        DownloadKind::Proton {
                            tag_name: tag.to_string()
                        }
                    );
                    if matches!(job.status, DownloadStatus::Verifying) {
                        saw_verifying = true;
                    }
                    if matches!(job.status, DownloadStatus::Completed) {
                        saw_completed = true;
                    }
                }
                Ok(LauncherEvent::ProtonInstalled { installation }) => {
                    installed_event = Some(installation);
                }
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => panic!("events closed"),
            }
        }
    })
    .await
    .expect("timed out waiting for GE-Proton install events");

    assert!(saw_verifying, "expected Verifying transition event");
    let inst = installed_event.unwrap();
    assert_eq!(inst.name, tag);
    assert_eq!(inst.source, ProtonSource::OpenSyncManaged);
    assert!(inst.proton_script.is_file());

    // Verify detect_proton() immediately discovers the newly installed GE-Proton
    let detected = core.detect_proton();
    let found = detected
        .iter()
        .find(|p| p.name == tag && p.source == ProtonSource::OpenSyncManaged)
        .expect("detect_proton must immediately discover newly installed GE-Proton");
    assert_eq!(found.proton_script, inst.proton_script);

    // Verify no leftover temp .part files remain after success
    for entry in fs::read_dir(&paths.proton_dir).unwrap() {
        let name = entry.unwrap().file_name().to_string_lossy().to_string();
        assert!(
            !name.ends_with(".part"),
            "temp tarball should be removed on success: {name}"
        );
    }

    // 3. Direct opensync_proton::download_and_install_ge_proton reports progress cleanly
    let direct_dir = tempdir().unwrap();
    let last_bytes = Arc::new(AtomicU64::new(0));
    let last_total = Arc::new(AtomicU64::new(0));
    let lb = last_bytes.clone();
    let lt = last_total.clone();
    let direct_inst = download_and_install_ge_proton(
        &format!("{}{}", srv.base_url, tarball_path),
        Some(&format!("{}{}", srv.base_url, sha_path)),
        direct_dir.path(),
        move |dl, tot| {
            lb.store(dl, Ordering::SeqCst);
            lt.store(tot, Ordering::SeqCst);
        },
    )
    .await
    .unwrap();
    assert_eq!(direct_inst.name, tag);
    assert_eq!(last_bytes.load(Ordering::SeqCst), tarball.len() as u64);
    assert_eq!(last_total.load(Ordering::SeqCst), tarball.len() as u64);
}

#[tokio::test]
async fn cover_caching_serves_from_disk_when_server_offline() {
    let dir = tempdir().unwrap();
    let db = LauncherDb::open_in_memory().unwrap();
    let secrets = MemorySecretStore::new();
    let paths = LauncherPaths::under(dir.path());
    let core = LauncherCore::new(db, secrets, paths.clone());

    let srv = MockOpenSyncServer::start().await;
    srv.add_user(1, "valerio", "secret123");
    srv.add_game(
        10,
        "Fogwoods",
        "fogwoods",
        vec![("fogwoods.sh", b"#!/bin/sh\n".to_vec())],
    );
    // Minimal valid PNG header + payload bytes
    let png_bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4];
    srv.set_cover(10, png_bytes.clone(), "image/png");

    core.connect_with_password("LAN", &srv.base_url, "valerio", "secret123")
        .await
        .unwrap();

    // First fetch hits the server and populates paths.cache_dir/covers/
    let (bytes1, ct1) = core.fetch_cached_cover(10).await.unwrap();
    assert_eq!(bytes1, png_bytes);
    assert_eq!(ct1, "image/png");
    assert!(paths.cache_dir.join("covers").is_dir());

    // Take server completely offline — cached cover MUST still load from disk!
    srv.set_offline(true);
    let (bytes2, ct2) = core.fetch_cached_cover(10).await.unwrap();
    assert_eq!(bytes2, png_bytes);
    assert_eq!(ct2, "image/png");

    // Uncached cover while offline fails with network error
    assert!(core.fetch_cached_cover(999).await.is_err());
}

#[tokio::test]
async fn uninstall_overrides_pending_syncs_events_and_delete_profile_cleanup() {
    let dir = tempdir().unwrap();
    let db = LauncherDb::open_in_memory().unwrap();
    let secrets = MemorySecretStore::new();
    let paths = LauncherPaths::under(dir.path());
    let core = LauncherCore::new(db, secrets.clone(), paths.clone());

    let srv_a = MockOpenSyncServer::start().await;
    srv_a.add_user(1, "alice", "passA123");
    srv_a.add_game(
        11,
        "OverrideTest",
        "override-test",
        vec![
            ("play.sh", b"#!/bin/sh\necho primary\n".to_vec()),
            ("alt/custom.sh", b"#!/bin/sh\necho custom > ran.txt\n".to_vec()),
        ],
    );
    srv_a.set_cover(11, vec![0xFF, 0xD8, 0xFF, 0xE0, 0, 1], "image/jpeg");

    let srv_b = MockOpenSyncServer::start().await;
    srv_b.add_user(1, "bob", "passB123");

    let prof_a = core
        .connect_with_password("Server A", &srv_a.base_url, "alice", "passA123")
        .await
        .unwrap();
    let (installed, _) = core
        .download_game(11, true, opensync_transfer::DownloadControl::new(0, 0))
        .await
        .unwrap();
    assert!(installed.install_dir.is_dir());

    // Cache a cover under profile A so we can verify delete_profile cleans it up too
    let (_, ct) = core.fetch_cached_cover(11).await.unwrap();
    assert_eq!(ct, "image/jpeg");

    // Set executable & Proton overrides and verify persistence
    core.set_game_executable(11, Some("alt/custom.sh".to_string()))
        .await
        .unwrap();
    core.set_game_proton(11, Some("GE-Proton9-25".to_string()))
        .await
        .unwrap();

    let games = core.list_downloaded_games().await.unwrap();
    assert_eq!(games[0].executable_rel_path.as_deref(), Some("alt/custom.sh"));
    assert_eq!(games[0].proton_override.as_deref(), Some("GE-Proton9-25"));

    // Path traversal executable override must be rejected
    assert!(core.set_game_executable(11, Some("../escape.sh".to_string())).await.is_err());

    // Launch while offline to verify GameSessionStarted/Ended events + list_pending_syncs
    let mut events = core.subscribe_events();
    srv_a.set_offline(true);
    assert!(!core.probe_connection().await.unwrap());

    let outcome = core
        .launch_game(
            11,
            LaunchOptions {
                auto_sync_on_close: true,
                sync_settle_delay: Duration::from_millis(10),
                heartbeat_interval: Duration::from_millis(50),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(outcome.exit_code, Some(0));
    // Verify the custom executable actually ran!
    assert_eq!(
        fs::read_to_string(installed.install_dir.join("alt/ran.txt")).unwrap(),
        "custom\n"
    );

    // Collect events and verify Started + Ended fired
    let mut saw_started = false;
    let mut saw_ended = false;
    while let Ok(ev) = events.try_recv() {
        match ev {
            LauncherEvent::GameSessionStarted {
                game_id,
                name,
                ..
            } => {
                assert_eq!(game_id, 11);
                assert_eq!(name, "OverrideTest");
                saw_started = true;
            }
            LauncherEvent::GameSessionEnded {
                game_id,
                synced,
                error,
                ..
            } => {
                assert_eq!(game_id, 11);
                assert!(!synced);
                assert!(error.is_some());
                saw_ended = true;
            }
            _ => {}
        }
    }
    assert!(saw_started, "expected GameSessionStarted event");
    assert!(saw_ended, "expected GameSessionEnded event");

    let pending = core.list_pending_syncs().await.unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].game_id, 11);

    // Clearing overrides works
    core.set_game_executable(11, None).await.unwrap();
    core.set_game_proton(11, None).await.unwrap();
    let games = core.list_downloaded_games().await.unwrap();
    assert!(games[0].executable_rel_path.is_none());
    assert!(games[0].proton_override.is_none());

    // Uninstall removes install_dir, DB row, and pending syncs
    core.uninstall_game(11).await.unwrap();
    assert!(!installed.install_dir.exists());
    assert!(core.list_downloaded_games().await.unwrap().is_empty());
    assert!(core.list_pending_syncs().await.unwrap().is_empty());
    assert!(matches!(
        core.uninstall_game(11).await,
        Err(CoreError::GameNotInstalled(11))
    ));

    // Create a second profile B, then switch back to A and delete A
    let prof_b = core
        .connect_with_password("Server B", &srv_b.base_url, "bob", "passB123")
        .await
        .unwrap();
    core.switch_profile(&prof_a.id).await.unwrap();

    // Drain events before deleting active profile A
    while events.try_recv().is_ok() {}
    core.delete_profile(&prof_a.id).await.unwrap();

    assert!(core.active_profile().await.is_none());
    assert_eq!(core.connection_state().await, ConnectionState::Disconnected);
    assert!(secrets.get(&prof_a.id).unwrap().is_none());
    assert!(!paths.library_root.join(&prof_a.id).exists());

    // Cached cover for profile A should be cleaned up
    let covers_left: Vec<_> = fs::read_dir(paths.cache_dir.join("covers"))
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().starts_with(&prof_a.id))
        .collect();
    assert!(covers_left.is_empty(), "profile A covers should be cleaned up");

    // ConnectionChanged(Disconnected) event emitted on active profile deletion
    let mut saw_disconnected = false;
    while let Ok(ev) = events.try_recv() {
        if matches!(
            ev,
            LauncherEvent::ConnectionChanged {
                state: ConnectionStateDto::Disconnected
            }
        ) {
            saw_disconnected = true;
        }
    }
    assert!(saw_disconnected, "expected ConnectionChanged(Disconnected)");

    // Profile B must still exist and remain usable
    let remaining = core.list_profiles().unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].id, prof_b.id);
    assert!(secrets.get(&prof_b.id).unwrap().is_some());

    // Deleting unknown profile returns ProfileNotFound
    assert!(matches!(
        core.delete_profile("missing-id").await,
        Err(CoreError::ProfileNotFound(_))
    ));
}

#[tokio::test]
async fn uninstall_syncs_saves_and_redownload_uses_remembered_install_dir() {
    let dir = tempdir().unwrap();
    let db = LauncherDb::open_in_memory().unwrap();
    let core = Arc::new(LauncherCore::new(
        db,
        MemorySecretStore::new(),
        LauncherPaths::under(dir.path()),
    ));

    let srv = MockOpenSyncServer::start().await;
    srv.add_user(1, "valerio", "secret123");
    srv.add_game(
        7,
        "Save Game",
        "save-game",
        vec![
            ("game.sh", b"#!/bin/sh\necho game\n".to_vec()),
            ("saves/slot1.dat", b"original save\n".to_vec()),
        ],
    );

    let profile = core
        .connect_with_password("LAN", &srv.base_url, "valerio", "secret123")
        .await
        .unwrap();
    let (installed, _) = core
        .download_game(7, true, opensync_transfer::DownloadControl::new(0, 0))
        .await
        .unwrap();
    let original_install_dir = installed.install_dir.clone();
    assert!(original_install_dir.is_dir());
    assert_eq!(srv.sync_count(), 0);

    // Edit an existing save and add a brand-new one locally.
    fs::write(
        original_install_dir.join("saves/slot1.dat"),
        b"modified save data\n",
    )
    .unwrap();
    fs::write(
        original_install_dir.join("saves/slot2.dat"),
        b"second save\n",
    )
    .unwrap();

    // Uninstall while online: local edits must reach the cloud before files are removed.
    let mut events = core.subscribe_events();
    core.uninstall_game(7).await.unwrap();
    assert!(!original_install_dir.exists());
    assert!(core
        .db()
        .get_installed_game(&profile.id, 7)
        .unwrap()
        .is_none());

    let overlay = srv.overlay_files(1, 7);
    assert_eq!(
        overlay.get("saves/slot1.dat").map(Vec::as_slice),
        Some(&b"modified save data\n"[..])
    );
    assert_eq!(
        overlay.get("saves/slot2.dat").map(Vec::as_slice),
        Some(&b"second save\n"[..])
    );
    assert_eq!(srv.sync_count(), 1, "uninstall committed one cloud sync");

    let remembered = core
        .db()
        .get_remembered_install_dir(&profile.id, 7)
        .unwrap()
        .expect("uninstall must remember the install dir");
    assert_eq!(remembered, original_install_dir);

    let mut saw_uninstall_sync = false;
    while let Ok(ev) = events.try_recv() {
        if matches!(
            ev,
            LauncherEvent::GameSyncCompleted { ref trigger, .. } if trigger == "uninstall"
        ) {
            saw_uninstall_sync = true;
        }
    }
    assert!(saw_uninstall_sync, "expected uninstall SaveSync event");

    let logs = core.list_activity_logs(50).await.unwrap();
    assert!(
        logs.iter()
            .any(|e| e.title.contains("Synced saves before uninstalling")),
        "uninstall must log the pre-removal save sync"
    );
    assert!(
        logs.iter().any(|e| e.title.contains("Uninstalled")),
        "uninstall must log an activity entry"
    );

    // Direct redownload restores the exact same directory with cloud saves intact.
    let (redownloaded, _) = core
        .download_game(7, false, opensync_transfer::DownloadControl::new(0, 0))
        .await
        .unwrap();
    assert_eq!(redownloaded.install_dir, original_install_dir);
    assert_eq!(
        fs::read(redownloaded.install_dir.join("saves/slot1.dat")).unwrap(),
        b"modified save data\n"
    );
    assert_eq!(
        fs::read(redownloaded.install_dir.join("saves/slot2.dat")).unwrap(),
        b"second save\n"
    );

    // Uninstall once more, then redownload through the managed Download Manager: it must also
    // extract into the remembered directory rather than rebuilding "<games>/<profile>/<slug>".
    core.uninstall_game(7).await.unwrap();
    assert_eq!(
        core.db()
            .get_remembered_install_dir(&profile.id, 7)
            .unwrap(),
        Some(original_install_dir.clone())
    );

    let mut events = core.subscribe_events();
    let job_id = core.start_game_download(7, false).await.unwrap();
    let completed = wait_for_download_status(&mut events, &job_id, |s| {
        matches!(s, DownloadStatus::Completed)
    })
    .await;
    assert_eq!(completed.status, DownloadStatus::Completed);
    let managed = core
        .db()
        .get_installed_game(&profile.id, 7)
        .unwrap()
        .expect("managed redownload must install the game");
    assert_eq!(managed.install_dir, original_install_dir);
    assert_eq!(
        fs::read(managed.install_dir.join("saves/slot1.dat")).unwrap(),
        b"modified save data\n"
    );
    assert!(managed.install_dir.join("saves/slot2.dat").is_file());
}

#[tokio::test]
async fn cover_content_type_cannot_escape_data_url() {
    let dir = tempdir().unwrap();
    let db = LauncherDb::open_in_memory().unwrap();
    let core = LauncherCore::new(db, MemorySecretStore::new(), LauncherPaths::under(dir.path()));

    let srv = MockOpenSyncServer::start().await;
    srv.add_user(1, "valerio", "secret123");
    srv.add_game(
        10,
        "Fogwoods",
        "fogwoods",
        vec![("fogwoods.sh", b"#!/bin/sh\n".to_vec())],
    );
    let png_bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4];
    // An on-path attacker rewriting the plaintext HTTP response tries to break out
    // of the frontend's `src="..."` attribute via the Content-Type header.
    srv.set_cover(10, png_bytes.clone(), "image/png\" onerror=\"alert(1)");

    core.connect_with_password("LAN", &srv.base_url, "valerio", "secret123")
        .await
        .unwrap();

    let (bytes, ct) = core.fetch_cached_cover(10).await.unwrap();
    assert_eq!(bytes, png_bytes);
    assert_eq!(
        ct, "image/png",
        "the MIME type must be one of the two safe literals, never a raw header"
    );
    assert!(!ct.contains('"') && !ct.contains("onerror"));
}

#[tokio::test]
async fn hostile_slug_cannot_escape_games_directory() {
    let dir = tempdir().unwrap();
    let db = LauncherDb::open_in_memory().unwrap();
    let core = LauncherCore::new(db, MemorySecretStore::new(), LauncherPaths::under(dir.path()));

    let srv = MockOpenSyncServer::start().await;
    srv.add_user(1, "valerio", "secret123");
    let escape_dir = dir.path().join("escaped");
    srv.add_game(
        20,
        "Absolute Slug",
        escape_dir.to_str().unwrap(),
        vec![("game.sh", b"#!/bin/sh\n".to_vec())],
    );
    srv.add_game(
        21,
        "Traversal Slug",
        "../escaped",
        vec![("game.sh", b"#!/bin/sh\n".to_vec())],
    );

    core.connect_with_password("LAN", &srv.base_url, "valerio", "secret123")
        .await
        .unwrap();

    for game_id in [20, 21] {
        let result = core
            .download_game(game_id, true, opensync_transfer::DownloadControl::new(0, 0))
            .await;
        assert!(result.is_err(), "game {game_id} has an unsafe slug and must be rejected");
    }
    assert!(
        !escape_dir.exists(),
        "no files may be written outside the games directory"
    );
}
