//! Cross-process serialization for LC file mutations.
//!
//! The TypeScript `FileLockManager` orders tool calls inside one LC process.
//! This native guard covers the sibling case: two LC executables mutating the
//! same canonical target. Locks are keyed by a normalized SHA-256 of the path,
//! acquired in sorted order, and released automatically on drop/process exit.

use sha2::{Digest, Sha256};
use std::io;
use std::path::{Path, PathBuf};

/// Holds every platform lock until the complete mutation is finished.
pub struct ProcessFileLocks {
    _guards: Vec<PlatformLock>,
}

impl ProcessFileLocks {
    /// Acquire exclusive locks for canonical mutation targets.
    ///
    /// Identities are sorted and deduplicated before blocking so overlapping
    /// multi-file patch calls cannot deadlock each other.
    pub fn acquire(paths: &[PathBuf]) -> io::Result<Self> {
        let mut identities: Vec<String> = paths.iter().map(|path| lock_identity(path)).collect();
        identities.sort();
        identities.dedup();

        let mut guards = Vec::with_capacity(identities.len());
        for identity in identities {
            guards.push(PlatformLock::acquire(&identity)?);
        }
        Ok(Self { _guards: guards })
    }
}

fn lock_identity(path: &Path) -> String {
    let raw = path.to_string_lossy();
    #[cfg(target_os = "windows")]
    let normalized = raw.replace('/', "\\").to_lowercase();
    #[cfg(not(target_os = "windows"))]
    let normalized = raw.into_owned();

    use std::fmt::Write as _;
    let digest = Sha256::digest(normalized.as_bytes());
    let mut identity = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut identity, "{byte:02x}").expect("writing to String cannot fail");
    }
    identity
}

#[cfg(target_os = "windows")]
struct PlatformLock {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(target_os = "windows")]
impl PlatformLock {
    fn acquire(identity: &str) -> io::Result<Self> {
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_ABANDONED, WAIT_OBJECT_0};
        use windows_sys::Win32::System::Threading::{CreateMutexW, WaitForSingleObject, INFINITE};

        let name: Vec<u16> = format!("Local\\LC.FileMutation.{identity}")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }

        let wait = unsafe { WaitForSingleObject(handle, INFINITE) };
        if wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED {
            Ok(Self { handle })
        } else {
            let error = io::Error::last_os_error();
            unsafe {
                CloseHandle(handle);
            }
            Err(error)
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for PlatformLock {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::ReleaseMutex;
        unsafe {
            ReleaseMutex(self.handle);
            CloseHandle(self.handle);
        }
    }
}

#[cfg(unix)]
struct PlatformLock {
    file: std::fs::File,
}

#[cfg(unix)]
impl PlatformLock {
    fn acquire(identity: &str) -> io::Result<Self> {
        use std::os::fd::AsRawFd;

        let directory = std::env::temp_dir().join("lc-file-mutation-locks");
        std::fs::create_dir_all(&directory)?;
        let path = directory.join(format!("{identity}.lock"));
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)?;
        let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
        if result != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { file })
    }
}

#[cfg(unix)]
impl Drop for PlatformLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        unsafe {
            libc::flock(self.file.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn same_target_waits_until_the_holder_drops() {
        let target = std::env::temp_dir().join(format!(
            "lc-process-file-lock-test-{:016x}.txt",
            rand::random::<u64>()
        ));
        let first = ProcessFileLocks::acquire(std::slice::from_ref(&target)).unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let (acquired_tx, acquired_rx) = mpsc::channel();
        let contender = target.clone();

        let thread = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            let guard = ProcessFileLocks::acquire(std::slice::from_ref(&contender)).unwrap();
            acquired_tx.send(()).unwrap();
            drop(guard);
        });

        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(acquired_rx.recv_timeout(Duration::from_millis(50)).is_err());
        drop(first);
        acquired_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        thread.join().unwrap();
    }

    #[test]
    fn duplicate_targets_are_acquired_once() {
        let target = std::env::temp_dir().join(format!(
            "lc-process-file-lock-dedupe-{:016x}.txt",
            rand::random::<u64>()
        ));
        let guard = ProcessFileLocks::acquire(&[target.clone(), target]).unwrap();
        drop(guard);
    }
}
