use chrono::{Duration as ChronoDuration, Utc};
use flate2::Compression;
use flate2::write::GzEncoder;
use launcher_db::{InstalledGame, LauncherDb};
use opensync_proton::{
    BinaryKind, ProtonError, ProtonSource, build_launch_command, detect_binary_kind,
    detect_proton_in_roots, discover_executables, install_ge_proton_archive,
};
use opensync_runner::{LaunchOptions, PostExitSyncStatus, SessionClock, launch_and_track};
use sha2::{Digest, Sha512};
use std::fs;
use std::time::Duration;
use tar::Builder;
use tempfile::tempdir;

#[test]
fn tracking_session_clock_excludes_system_suspend_sleep_jumps() {
    let start = Utc::now();
    let mut clock = SessionClock::start(start).with_suspend_threshold(Duration::from_secs(15));

    // Normal active play: 3 heartbeats of 5 seconds each (15s total)
    clock.tick(start + ChronoDuration::seconds(5), Duration::from_secs(5));
    clock.tick(start + ChronoDuration::seconds(10), Duration::from_secs(10));
    clock.tick(start + ChronoDuration::seconds(15), Duration::from_secs(15));
    assert_eq!(clock.active_secs(), 15);

    // Laptop lid closed / suspended for 2 hours: wall clock advances +7200s, monotonic only +1s
    clock.tick(
        start + ChronoDuration::seconds(15 + 7200),
        Duration::from_secs(16),
    );
    // Unix monotonic clocks stop during sleep, so the 1s before sleep is counted.
    #[cfg(unix)]
    assert_eq!(
        clock.active_secs(),
        16,
        "2-hour suspend gap must NOT be counted as screen time"
    );
    // Windows `Instant` keeps ticking through sleep; the conservative cap drops the tick.
    #[cfg(not(unix))]
    assert_eq!(
        clock.active_secs(),
        15,
        "2-hour suspend gap must NOT be counted as screen time"
    );

    // User resumes playing for 10 more seconds (two 5s ticks)
    clock.tick(
        start + ChronoDuration::seconds(15 + 7200 + 5),
        Duration::from_secs(21),
    );
    clock.tick(
        start + ChronoDuration::seconds(15 + 7200 + 10),
        Duration::from_secs(26),
    );
    #[cfg(unix)]
    assert_eq!(clock.active_secs(), 26);
    #[cfg(not(unix))]
    assert_eq!(clock.active_secs(), 25);
}

#[tokio::test]
async fn tracking_records_real_process_sessions_and_accumulates_playtime() {
    let dir = tempdir().unwrap();
    let db = LauncherDb::open_in_memory().unwrap();
    let profile = db
        .upsert_profile("LAN", "http://127.0.0.1:3000", "valerio", 1, "admin")
        .unwrap();

    // Create a real runnable placeholder game script that sleeps ~1.1s so active_secs >= 1
    let game_dir = dir.path().join("fogwoods");
    fs::create_dir_all(&game_dir).unwrap();
    let script_path = game_dir.join("fogwoods.sh");
    fs::write(&script_path, "#!/bin/sh\nsleep 1.1\n").unwrap();

    let installed = InstalledGame {
        profile_id: profile.id.clone(),
        game_id: 42,
        name: "Fogwoods".to_string(),
        slug: "fogwoods".to_string(),
        install_dir: game_dir.clone(),
        executable_rel_path: Some("fogwoods.sh".to_string()),
        manifest_hash: None,
        total_size: 1024,
        installed_at: Utc::now(),
        last_synced_at: None,
        proton_override: None,
    };
    db.upsert_installed_game(&installed).unwrap();

    let opts = LaunchOptions {
        auto_sync_on_close: false,
        sync_settle_delay: Duration::ZERO,
        heartbeat_interval: Duration::from_millis(250),
        extra_args: vec![],
        prefixes_root: dir.path().join("prefixes"),
    };

    let first = launch_and_track(&db, None, &installed, None, opts.clone())
        .await
        .unwrap();
    assert_eq!(first.exit_code, Some(0));
    assert!(matches!(
        first.sync_status,
        PostExitSyncStatus::SkippedDisabled
    ));
    assert!(
        first.session.duration_secs >= 1,
        "expected >= 1s active screen time, got {}",
        first.session.duration_secs
    );
    assert_eq!(first.session.runtime, "native");

    // Second session accumulates total screen time and updates session_count
    let second = launch_and_track(&db, None, &installed, None, opts)
        .await
        .unwrap();
    assert!(second.session.duration_secs >= 1);

    let summary = db.playtime_summary(&profile.id, 42).unwrap();
    assert_eq!(summary.session_count, 2);
    assert!(summary.total_secs >= 2);
    assert!(summary.last_played_at.is_some());
}

#[test]
fn proton_auto_detection_binary_classification_and_ge_installer() {
    let dir = tempdir().unwrap();

    // 1. Binary magic-byte classification & executable discovery (filters redistributables)
    let game_dir = dir.path().join("my_win_game");
    fs::create_dir_all(game_dir.join("_CommonRedist")).unwrap();
    fs::write(game_dir.join("unins000.exe"), b"MZ\x90\x00uninstaller").unwrap();
    fs::write(
        game_dir.join("_CommonRedist/vcredist_x64.exe"),
        b"MZ\x90\x00redist",
    )
    .unwrap();
    fs::write(
        game_dir.join("CyberRunner.exe"),
        vec![b'M', b'Z', 0x90, 0x00, 0x01, 0x02],
    )
    .unwrap();
    fs::write(game_dir.join("helper.dll"), b"MZ\x90\x00dll").unwrap();
    fs::write(game_dir.join("native_tool"), b"\x7fELF\x02\x01\x01\x00").unwrap();

    assert_eq!(
        detect_binary_kind(&game_dir.join("CyberRunner.exe")),
        BinaryKind::WindowsPe
    );
    assert_eq!(
        detect_binary_kind(&game_dir.join("native_tool")),
        BinaryKind::LinuxElf
    );

    let exes = discover_executables(&game_dir, "Cyber Runner");
    assert_eq!(exes[0].rel_path, "CyberRunner.exe");
    assert_eq!(exes[0].kind, BinaryKind::WindowsPe);
    assert!(exes.iter().all(|e| !e.rel_path.contains("unins")
        && !e.rel_path.contains("vcredist")
        && !e.rel_path.ends_with(".dll")));

    // 2. Proton auto-detection prioritizes OpenSyncManaged > SteamCompatTools > SteamCommon
    let managed = dir.path().join("managed");
    let steam_compat = dir.path().join("compat");
    let steam_common = dir.path().join("common");
    fs::create_dir_all(managed.join("GE-Proton9-25")).unwrap();
    fs::write(managed.join("GE-Proton9-25/proton"), "#!/bin/sh\n").unwrap();
    fs::create_dir_all(steam_compat.join("GE-Proton9-20")).unwrap();
    fs::write(steam_compat.join("GE-Proton9-20/proton"), "#!/bin/sh\n").unwrap();
    fs::create_dir_all(steam_common.join("Proton 9.0")).unwrap();
    fs::write(steam_common.join("Proton 9.0/proton"), "#!/bin/sh\n").unwrap();

    let detected = detect_proton_in_roots(&[
        (steam_common.clone(), ProtonSource::SteamCommon),
        (steam_compat.clone(), ProtonSource::SteamCompatTools),
        (managed.clone(), ProtonSource::OpenSyncManaged),
    ]);
    assert_eq!(detected.len(), 3);
    assert_eq!(detected[0].name, "GE-Proton9-25");
    assert_eq!(detected[0].source, ProtonSource::OpenSyncManaged);
    assert_eq!(detected[1].name, "GE-Proton9-20");
    assert_eq!(detected[2].name, "Proton 9.0");

    // 3. Launching Windows PE without a compatibility runtime.
    let prefix = dir.path().join("prefixes/1");
    #[cfg(not(target_os = "macos"))]
    {
        // Linux/Windows require Proton for a Windows PE binary.
        let err = build_launch_command(&exes[0], &prefix, None, &[]).unwrap_err();
        assert!(matches!(err, ProtonError::NotInstalled));

        // With Proton detected, builds isolated STEAM_COMPAT_DATA_PATH launch command
        let cmd = build_launch_command(
            &exes[0],
            &prefix,
            Some(&detected[0]),
            &["--windowed".into()],
        )
        .unwrap();
        assert!(
            cmd.env
                .iter()
                .any(|(k, v)| k == "STEAM_COMPAT_DATA_PATH" && v.contains("prefixes"))
        );
        assert!(cmd.args.iter().any(|a| a.ends_with("CyberRunner.exe")));
        assert!(cmd.args.contains(&"--windowed".to_string()));
    }
    #[cfg(target_os = "macos")]
    {
        // macOS never executes a Linux Proton script. It either uses a configured
        // Wine/Whisky/CrossOver runner or cleanly falls back to native execution.
        let cmd = build_launch_command(&exes[0], &prefix, None, &[]).unwrap();
        assert!(cmd.program.is_absolute());
        let cmd = build_launch_command(
            &exes[0],
            &prefix,
            Some(&detected[0]),
            &["--windowed".into()],
        )
        .unwrap();
        assert!(
            cmd.program.ends_with("CyberRunner.exe")
                || cmd.args.iter().any(|a| a.ends_with("CyberRunner.exe"))
        );
        assert!(cmd.args.contains(&"--windowed".to_string()));
    }

    // 4. GE-Proton tarball SHA-512 verification & extraction
    let tarball_path = dir.path().join("GE-Proton9-99.tar.gz");
    {
        let tar_gz = fs::File::create(&tarball_path).unwrap();
        let enc = GzEncoder::new(tar_gz, Compression::default());
        let mut tar = Builder::new(enc);
        let content = b"#!/bin/sh\necho proton\n";
        let mut header = tar::Header::new_gnu();
        header.set_size(content.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        tar.append_data(&mut header, "GE-Proton9-99/proton", &content[..])
            .unwrap();
        tar.finish().unwrap();
    }
    let valid_sha512 = hex::encode(Sha512::digest(fs::read(&tarball_path).unwrap()));
    let install_dest = dir.path().join("fresh-managed");

    // Wrong checksum rejected
    let bad = install_ge_proton_archive(&tarball_path, Some("0000deadbeef"), &install_dest);
    assert!(matches!(bad, Err(ProtonError::ChecksumMismatch { .. })));

    // Valid checksum extracts cleanly
    let installed_proton =
        install_ge_proton_archive(&tarball_path, Some(&valid_sha512), &install_dest).unwrap();
    assert_eq!(installed_proton.name, "GE-Proton9-99");
    assert!(installed_proton.proton_script.is_file());
}
