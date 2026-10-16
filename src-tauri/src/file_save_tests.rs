use super::*;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_DIR_ID: AtomicU64 = AtomicU64::new(0);

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        let id = TEST_DIR_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "openquire-file-save-test-{}-{id}",
            std::process::id()
        ));
        fs::create_dir(&path).expect("create unique test directory");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn file(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }

    fn assert_no_temporary_files(&self) {
        let survivors: Vec<_> = fs::read_dir(&self.0)
            .expect("read test directory")
            .map(|entry| entry.expect("read directory entry").file_name())
            .filter(|name| name.to_string_lossy().ends_with(".saving"))
            .collect();
        assert!(survivors.is_empty(), "temporary files remain: {survivors:?}");
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn writes_new_file_and_replaces_existing_file() {
    let dir = TestDir::new();
    let new_file = dir.file("new.pdf");
    write_atomic(&new_file, b"complete new document").unwrap();
    assert_eq!(fs::read(&new_file).unwrap(), b"complete new document");

    let existing = dir.file("existing.pdf");
    fs::write(&existing, b"old document").unwrap();
    write_atomic(&existing, b"complete replacement").unwrap();
    assert_eq!(fs::read(&existing).unwrap(), b"complete replacement");
    dir.assert_no_temporary_files();
}

#[test]
fn existing_openquire_saving_file_is_never_truncated_or_removed() {
    let dir = TestDir::new();
    let target = dir.file("foo.pdf");
    let unrelated = dir.file("foo.pdf.openquire-saving");
    fs::write(&target, b"original").unwrap();
    fs::write(&unrelated, b"user's unrelated file").unwrap();

    write_atomic(&target, b"replacement").unwrap();

    assert_eq!(fs::read(&target).unwrap(), b"replacement");
    assert_eq!(fs::read(&unrelated).unwrap(), b"user's unrelated file");
    dir.assert_no_temporary_files();
}

#[test]
fn failed_partial_write_preserves_destination_and_cleans_temporary() {
    let dir = TestDir::new();
    let target = dir.file("document.pdf");
    fs::write(&target, b"original bytes").unwrap();

    let error = replace_with(
        &target,
        |file| {
            file.write_all(b"partial")?;
            Err(io::Error::new(io::ErrorKind::Other, "injected write failure"))
        },
        commit,
    )
    .unwrap_err();

    assert_eq!(error.to_string(), "injected write failure");
    assert_eq!(fs::read(&target).unwrap(), b"original bytes");
    dir.assert_no_temporary_files();
}

#[test]
fn failed_commit_preserves_destination_and_cleans_temporary() {
    let dir = TestDir::new();
    let target = dir.file("document.pdf");
    fs::write(&target, b"original bytes").unwrap();

    let error = replace_with(
        &target,
        |file| file.write_all(b"complete candidate"),
        |_, _| Err(io::Error::new(io::ErrorKind::Other, "injected commit failure")),
    )
    .unwrap_err();

    assert_eq!(error.to_string(), "injected commit failure");
    assert_eq!(fs::read(&target).unwrap(), b"original bytes");
    dir.assert_no_temporary_files();
}

#[test]
fn concurrent_writes_leave_one_complete_payload_and_no_temporaries() {
    let dir = TestDir::new();
    let target = dir.file("contended.pdf");
    let payloads: Vec<Vec<u8>> = (0..6)
        .map(|index| vec![b'A' + index; 256 * 1024])
        .collect();
    let handles: Vec<_> = payloads
        .iter()
        .cloned()
        .map(|payload| {
            let target = target.clone();
            std::thread::spawn(move || write_atomic(&target, &payload))
        })
        .collect();
    for handle in handles {
        handle.join().expect("writer thread panicked").unwrap();
    }

    let final_bytes = fs::read(&target).unwrap();
    assert!(payloads.iter().any(|payload| *payload == final_bytes));
    dir.assert_no_temporary_files();
}

#[test]
fn missing_parent_and_directory_destination_return_errors() {
    let dir = TestDir::new();
    let missing_parent = dir.file("missing/new.pdf");
    assert!(write_atomic(&missing_parent, b"data").is_err());
    assert!(!dir.file("missing").exists());

    let destination_dir = dir.file("destination-dir");
    fs::create_dir(&destination_dir).unwrap();
    assert!(write_atomic(&destination_dir, b"data").is_err());
    assert!(destination_dir.is_dir());
    dir.assert_no_temporary_files();
}

#[cfg(unix)]
#[test]
fn replacement_preserves_existing_unix_mode() {
    use std::os::unix::fs::{PermissionsExt, *};

    let dir = TestDir::new();
    let target = dir.file("private.pdf");
    fs::write(&target, b"old").unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o640)).unwrap();

    write_atomic(&target, b"new").unwrap();

    assert_eq!(fs::read(&target).unwrap(), b"new");
    assert_eq!(fs::metadata(&target).unwrap().permissions().mode() & 0o777, 0o640);
}

#[cfg(unix)]
#[test]
fn saving_through_symlink_updates_target_and_dangling_link_is_rejected() {
    use std::os::unix::fs::symlink;

    let dir = TestDir::new();
    let target = dir.file("real.pdf");
    let link = dir.file("alias.pdf");
    fs::write(&target, b"old").unwrap();
    symlink(&target, &link).unwrap();

    write_atomic(&link, b"updated through link").unwrap();

    assert_eq!(fs::read(&target).unwrap(), b"updated through link");
    assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
    assert_eq!(fs::read_link(&link).unwrap(), target);

    let dangling = dir.file("dangling.pdf");
    symlink(dir.file("absent.pdf"), &dangling).unwrap();
    assert!(write_atomic(&dangling, b"must not create target").is_err());
    assert!(!dir.file("absent.pdf").exists());
    dir.assert_no_temporary_files();
}

#[cfg(windows)]
#[test]
fn locked_windows_destination_rejects_replacement_and_cleans_temporary() {
    use std::os::windows::fs::OpenOptionsExt;

    let dir = TestDir::new();
    let target = dir.file("locked.pdf");
    fs::write(&target, b"original").unwrap();
    let lock = OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&target)
        .unwrap();

    assert!(write_atomic(&target, b"replacement").is_err());
    drop(lock);
    assert_eq!(fs::read(&target).unwrap(), b"original");
    dir.assert_no_temporary_files();
}

#[cfg(windows)]
#[test]
fn replace_file_error_1177_restores_original_when_destination_is_absent() {
    let dir = TestDir::new();
    let backup_path = dir.file("recover-backup.saving");
    let destination = dir.file("document.pdf");
    fs::write(&backup_path, b"original bytes").unwrap();

    let result = recover_windows_error(
        io::Error::from_raw_os_error(1177),
        Temporary(backup_path.clone()),
        &destination,
    );

    assert!(result.is_err(), "the failed ReplaceFile operation must remain an error");
    assert_eq!(fs::read(&destination).unwrap(), b"original bytes");
    assert!(!backup_path.exists());
}

#[cfg(windows)]
#[test]
fn replace_file_error_1177_keeps_backup_when_original_cannot_be_restored() {
    let dir = TestDir::new();
    let backup_path = dir.file("recover-backup.saving");
    let destination = dir.file("document.pdf");
    fs::write(&backup_path, b"original bytes").unwrap();
    fs::create_dir(&destination).unwrap();

    let error = recover_windows_error(
        io::Error::from_raw_os_error(1177),
        Temporary(backup_path.clone()),
        &destination,
    )
    .unwrap_err();

    assert!(error.to_string().contains(&backup_path.display().to_string()));
    assert_eq!(fs::read(&backup_path).unwrap(), b"original bytes");
}
