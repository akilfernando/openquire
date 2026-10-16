//! Replace a document only after its complete sibling temporary file is flushed.
//! Commits are serialized within this desktop process. External programs are not
//! locked out, and directory-entry durability across power loss is not promised.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

static SAVES: Mutex<()> = Mutex::new(());
static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);

struct Temporary(PathBuf);

#[cfg(windows)]
impl Temporary {
    fn keep(self) -> PathBuf {
        let path = self.0.clone();
        std::mem::forget(self);
        path
    }
}

impl Drop for Temporary {
    fn drop(&mut self) {
        #[cfg(windows)]
        if let Ok(metadata) = fs::metadata(&self.0) {
            if metadata.permissions().readonly() {
                let mut permissions = metadata.permissions();
                permissions.set_readonly(false);
                let _ = fs::set_permissions(&self.0, permissions);
            }
        }
        // After a successful rename the old temporary name no longer exists.
        let _ = fs::remove_file(&self.0);
    }
}

fn destination(path: &Path) -> io::Result<PathBuf> {
    match fs::symlink_metadata(path) {
        Ok(_) => {
            let real = fs::canonicalize(path)?;
            if !fs::metadata(&real)?.is_file() {
                return Err(io::Error::new(io::ErrorKind::InvalidInput, "The save destination is not a file"));
            }
            // Saving a symlink opened by the user updates its real document,
            // preserving the link itself. Dangling links fail before any write.
            Ok(real)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let name = path.file_name().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Missing filename"))?;
            let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
            Ok(fs::canonicalize(parent)?.join(name))
        }
        Err(error) => Err(error),
    }
}

fn new_temporary(parent: &Path) -> io::Result<(Temporary, File)> {
    for _ in 0..128 {
        let number = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!(".openquire-{}-{number}.saving", std::process::id()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(file) => return Ok((Temporary(path), file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(io::ErrorKind::AlreadyExists, "No unused temporary save filename was available"))
}

fn replace_with<W, C>(path: &Path, write: W, commit: C) -> io::Result<()>
where
    W: FnOnce(&mut File) -> io::Result<()>,
    C: FnOnce(&Path, &Path) -> io::Result<()>,
{
    // A single commit queue also covers symlink/case aliases on Windows without
    // relying on string equality to identify a physical destination.
    let _save = SAVES.lock().map_err(|_| io::Error::other("The save queue was interrupted. Restart OpenQuire before saving again."))?;
    let path = destination(path)?;
    let permissions = match fs::metadata(&path) {
        Ok(metadata) => Some(metadata.permissions()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    let (temporary, mut file) = new_temporary(path.parent().expect("canonical destination has a parent"))?;
    write(&mut file)?;
    if let Some(permissions) = permissions {
        file.set_permissions(permissions)?;
    }
    file.sync_all()?;
    // Windows replacement requires releasing our handle before rename.
    drop(file);
    commit(&temporary.0, &path)
}

pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    replace_with(path, |file| file.write_all(bytes), commit)
}

#[cfg(not(windows))]
fn commit(temporary: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(temporary, destination)
}

#[cfg(windows)]
fn commit(temporary: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    #[link(name = "kernel32")]
    extern "system" {
        fn ReplaceFileW(
            replaced: *const u16, replacement: *const u16, backup: *const u16,
            flags: u32, exclude: *mut std::ffi::c_void, reserved: *mut std::ffi::c_void,
        ) -> i32;
    }

    match fs::metadata(destination) {
        // ReplaceFile preserves the existing document's Windows ACL/metadata.
        // Do not ignore merge errors or delete the original as a fallback.
        Ok(_) => {
            // ReplaceFile has documented late-failure states in which the old
            // document has moved. Always name a backup so those states retain
            // the original, then restore it before reporting failure.
            let (backup, file) = new_temporary(destination.parent().expect("destination has a parent"))?;
            drop(file);
            fs::remove_file(&backup.0)?;
            let destination_wide: Vec<u16> = destination.as_os_str().encode_wide().chain(Some(0)).collect();
            let temporary_wide: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
            let backup_wide: Vec<u16> = backup.0.as_os_str().encode_wide().chain(Some(0)).collect();
            let success = unsafe {
                ReplaceFileW(destination_wide.as_ptr(), temporary_wide.as_ptr(), backup_wide.as_ptr(), 0, ptr::null_mut(), ptr::null_mut())
            };
            if success != 0 { return Ok(()) }
            recover_windows_error(io::Error::last_os_error(), backup, destination)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => fs::rename(temporary, destination),
        Err(error) => Err(error),
    }
}

#[cfg(windows)]
fn recover_windows_error(error: io::Error, backup: Temporary, destination: &Path) -> io::Result<()> {
    // ERROR_UNABLE_TO_MOVE_REPLACEMENT_2: the original is at backup.
    if error.raw_os_error() == Some(1177) {
        if let Err(restore) = fs::rename(&backup.0, destination) {
            let original = backup.keep();
            return Err(io::Error::other(format!(
                "Save failed ({error}); restoring the original failed ({restore}). The original is preserved at {}",
                original.display()
            )));
        }
    }
    Err(error)
}

#[cfg(test)]
#[path = "file_save_tests.rs"]
mod tests;
