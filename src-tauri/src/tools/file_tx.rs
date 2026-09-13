//! Shared single-file transaction primitive for file mutations.
//!
//! Content is staged in the target directory, flushed, synced, and then
//! committed. Existing Windows targets use ReplaceFileW; Unix uses rename.
//! Create-only commits never replace an existing destination.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub struct FileTransaction {
    target: PathBuf,
    tmp: PathBuf,
    file: Option<fs::File>,
    written: bool,
}

impl FileTransaction {
    pub fn new(target: &Path) -> io::Result<Self> {
        let parent = target.parent().unwrap_or(target);
        if !parent.exists() {
            fs::create_dir_all(parent)?;
        }
        let name = target
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("file");

        for _ in 0..16 {
            let suffix: u64 = rand::random();
            let tmp = parent.join(format!(".{}.{:016x}.lc-tmp", name, suffix));
            match OpenOptions::new().write(true).create_new(true).open(&tmp) {
                Ok(file) => {
                    return Ok(Self {
                        target: target.to_path_buf(),
                        tmp,
                        file: Some(file),
                        written: false,
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "FileTransaction: could not allocate a unique staging file",
        ))
    }

    pub fn write_all(&mut self, content: &[u8]) -> io::Result<()> {
        if self.written {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "FileTransaction: staging content was already written",
            ));
        }
        let file = self.file.as_mut().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::BrokenPipe,
                "FileTransaction: staging file is closed",
            )
        })?;
        {
            let mut writer = io::BufWriter::new(&mut *file);
            writer.write_all(content)?;
            writer.flush()?;
        }
        file.sync_all()?;
        self.written = true;
        Ok(())
    }

    pub fn write_str(&mut self, content: &str) -> io::Result<()> {
        self.write_all(content.as_bytes())
    }

    pub fn commit(mut self) -> io::Result<()> {
        self.ensure_written()?;
        self.file.take();
        if self.target.exists() {
            if let Ok(metadata) = fs::metadata(&self.target) {
                fs::set_permissions(&self.tmp, metadata.permissions())?;
            }
        }
        replace_staged(&self.tmp, &self.target)?;
        sync_parent(&self.target);
        Ok(())
    }

    pub fn commit_create(mut self) -> io::Result<()> {
        self.ensure_written()?;
        self.file.take();
        create_from_staged(&self.tmp, &self.target)?;
        sync_parent(&self.target);
        Ok(())
    }

    fn ensure_written(&self) -> io::Result<()> {
        if self.written {
            Ok(())
        } else {
            Err(io::Error::other(
                "FileTransaction: commit called before write",
            ))
        }
    }

    #[allow(dead_code)]
    pub fn target(&self) -> &Path {
        &self.target
    }

    #[allow(dead_code)]
    pub fn tmp_path(&self) -> &Path {
        &self.tmp
    }
}

impl Drop for FileTransaction {
    fn drop(&mut self) {
        self.file.take();
        let _ = fs::remove_file(&self.tmp);
    }
}

fn sync_parent(target: &Path) {
    if let Some(parent) = target.parent() {
        if let Ok(directory) = fs::File::open(parent) {
            let _ = directory.sync_all();
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn replace_staged(staged: &Path, target: &Path) -> io::Result<()> {
    fs::rename(staged, target)
}

#[cfg(not(target_os = "windows"))]
fn create_from_staged(staged: &Path, target: &Path) -> io::Result<()> {
    fs::hard_link(staged, target)?;
    let _ = fs::remove_file(staged);
    Ok(())
}

#[cfg(target_os = "windows")]
fn wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

#[cfg(target_os = "windows")]
fn replace_staged(staged: &Path, target: &Path) -> io::Result<()> {
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, ReplaceFileW};

    let target_exists = target.exists();
    let staged = wide(staged);
    let target = wide(target);
    let success = unsafe {
        if target_exists {
            ReplaceFileW(
                target.as_ptr(),
                staged.as_ptr(),
                std::ptr::null(),
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        } else {
            MoveFileExW(staged.as_ptr(), target.as_ptr(), 0)
        }
    };
    if success == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn create_from_staged(staged: &Path, target: &Path) -> io::Result<()> {
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

    let staged = wide(staged);
    let target = wide(target);
    let success = unsafe { MoveFileExW(staged.as_ptr(), target.as_ptr(), 0) };
    if success == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("lc-file-tx-test-{:016x}", rand::random::<u64>()));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn create_write_commit_read() {
        let directory = TempDir::new();
        let target = directory.path().join("test.txt");
        let mut transaction = FileTransaction::new(&target).unwrap();
        transaction.write_str("hello world").unwrap();
        transaction.commit().unwrap();
        assert_eq!(fs::read_to_string(target).unwrap(), "hello world");
    }

    #[test]
    fn staging_file_exists_immediately_and_is_cleaned_on_drop() {
        let directory = TempDir::new();
        let target = directory.path().join("drop.txt");
        let staging;
        {
            let transaction = FileTransaction::new(&target).unwrap();
            staging = transaction.tmp_path().to_path_buf();
            assert!(staging.exists());
        }
        assert!(!staging.exists());
        assert!(!target.exists());
    }

    #[test]
    fn overwrite_existing_file() {
        let directory = TempDir::new();
        let target = directory.path().join("overwrite.txt");
        fs::write(&target, "original").unwrap();
        let mut transaction = FileTransaction::new(&target).unwrap();
        transaction.write_str("replacement").unwrap();
        transaction.commit().unwrap();
        assert_eq!(fs::read_to_string(target).unwrap(), "replacement");
    }

    #[test]
    fn create_only_rejects_existing_destination() {
        let directory = TempDir::new();
        let target = directory.path().join("existing.txt");
        fs::write(&target, "sentinel").unwrap();
        let mut transaction = FileTransaction::new(&target).unwrap();
        transaction.write_str("replacement").unwrap();
        let error = transaction.commit_create().unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(target).unwrap(), "sentinel");
    }

    #[test]
    fn creates_parent_directories() {
        let directory = TempDir::new();
        let target = directory.path().join("nested").join("file.txt");
        let mut transaction = FileTransaction::new(&target).unwrap();
        transaction.write_str("content").unwrap();
        transaction.commit_create().unwrap();
        assert_eq!(fs::read_to_string(target).unwrap(), "content");
    }

    #[test]
    fn write_is_single_use() {
        let directory = TempDir::new();
        let target = directory.path().join("single.txt");
        let mut transaction = FileTransaction::new(&target).unwrap();
        transaction.write_str("first").unwrap();
        assert_eq!(
            transaction.write_str("second").unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
    }
}
