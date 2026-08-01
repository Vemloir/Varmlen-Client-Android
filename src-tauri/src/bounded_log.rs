use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct BoundedLog {
    path: PathBuf,
    max_bytes: u64,
    rotated_files: usize,
}

impl BoundedLog {
    pub fn new(path: PathBuf, max_bytes: u64, rotated_files: usize) -> Self {
        Self {
            path,
            max_bytes: max_bytes.max(1),
            rotated_files,
        }
    }

    pub fn append(&self, bytes: &[u8]) -> io::Result<()> {
        if bytes.is_empty() {
            return Ok(());
        }
        let current = fs::metadata(&self.path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if current.saturating_add(bytes.len() as u64) > self.max_bytes {
            self.rotate()?;
        }
        let start = bytes.len().saturating_sub(self.max_bytes as usize);
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        file.write_all(&bytes[start..])?;
        file.flush()
    }

    fn rotate(&self) -> io::Result<()> {
        if self.rotated_files == 0 {
            return match fs::remove_file(&self.path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error),
            };
        }
        remove_if_exists(&self.rotated_path(self.rotated_files))?;
        for index in (1..self.rotated_files).rev() {
            rename_if_exists(&self.rotated_path(index), &self.rotated_path(index + 1))?;
        }
        rename_if_exists(&self.path, &self.rotated_path(1))
    }

    fn rotated_path(&self, index: usize) -> PathBuf {
        PathBuf::from(format!("{}.{}", self.path.display(), index))
    }
}

fn remove_if_exists(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn rename_if_exists(from: &Path, to: &Path) -> io::Result<()> {
    match fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::BoundedLog;

    #[test]
    fn rotates_during_a_continuous_session_and_bounds_the_current_file() {
        let directory = std::env::temp_dir().join(format!(
            "varmlen-log-test-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("rotation")
        ));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("varmlen.log");
        let store = BoundedLog::new(path.clone(), 32, 3);

        store.append(&[b'a'; 32]).unwrap();
        store.append(b"new line\n").unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"new line\n");
        assert_eq!(
            std::fs::read(directory.join("varmlen.log.1"))
                .unwrap()
                .len(),
            32
        );
        assert!(std::fs::metadata(path).unwrap().len() <= 32);
        let _ = std::fs::remove_dir_all(directory);
    }
}
