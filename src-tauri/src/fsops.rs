//! Plain filesystem operations for the file explorer and editor: directory
//! listing, read/write, and the explorer's file management (create / rename /
//! copy / move-to-Trash / reveal-in-Finder).
//!
//! All commands run their blocking I/O on the blocking thread pool so large
//! files never stall the async runtime (which also serves terminal IPC).

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    text: String,
    binary: bool,
    truncated: bool,
}

/// Files larger than this are truncated (on a char boundary) before being
/// sent to the webview. Workspace search (search.rs) skips such files
/// entirely so its notion of "searchable" matches the editor's "editable".
pub(crate) const MAX_TEXT_BYTES: usize = 5 * 1024 * 1024;

/// Number of leading bytes inspected for NUL to classify a file as binary.
pub(crate) const BINARY_SNIFF_BYTES: usize = 8000;

#[tauri::command]
pub async fn fs_read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || read_dir_impl(&path))
        .await
        .map_err(|e| e.to_string())?
}

fn read_dir_impl(path: &str) -> Result<Vec<DirEntry>, String> {
    let read = std::fs::read_dir(path).map_err(|e| e.to_string())?;

    let mut entries: Vec<DirEntry> = Vec::new();
    for entry in read {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        let entry_path = entry.path();
        // metadata() follows symlinks; broken links count as files.
        let is_dir = std::fs::metadata(&entry_path)
            .map(|m| m.is_dir())
            .unwrap_or(false);
        entries.push(DirEntry {
            name,
            path: entry_path.to_string_lossy().into_owned(),
            is_dir,
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

#[tauri::command]
pub async fn fs_read_file(path: String) -> Result<FileContent, String> {
    tauri::async_runtime::spawn_blocking(move || read_file_impl(&path))
        .await
        .map_err(|e| e.to_string())?
}

fn read_file_impl(path: &str) -> Result<FileContent, String> {
    // Read at most MAX_TEXT_BYTES + 1 so huge files are never fully loaded;
    // the extra byte tells us whether truncation happened.
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut buf: Vec<u8> = Vec::new();
    file.take(MAX_TEXT_BYTES as u64 + 1)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;

    let truncated = buf.len() > MAX_TEXT_BYTES;
    if truncated {
        buf.truncate(MAX_TEXT_BYTES);
    }

    if buf.iter().take(BINARY_SNIFF_BYTES).any(|&b| b == 0) {
        return Ok(FileContent {
            text: String::new(),
            binary: true,
            truncated: false,
        });
    }

    match String::from_utf8(buf) {
        Ok(text) => Ok(FileContent {
            text,
            binary: false,
            truncated,
        }),
        Err(e) => {
            let valid = e.utf8_error().valid_up_to();
            let bytes = e.into_bytes();
            if truncated && bytes.len() - valid < 4 {
                // The 5 MB cut split a multi-byte character: drop the partial
                // tail and keep the (truncated) text.
                let text = String::from_utf8(bytes[..valid].to_vec())
                    .map_err(|e| e.to_string())?;
                Ok(FileContent {
                    text,
                    binary: false,
                    truncated: true,
                })
            } else {
                // Genuinely non-UTF-8 content. Do NOT lossy-decode: editing a
                // lossy view and saving it would silently corrupt the file.
                Ok(FileContent {
                    text: String::new(),
                    binary: true,
                    truncated: false,
                })
            }
        }
    }
}

#[tauri::command]
pub async fn fs_write_file(path: String, text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_file_impl(&path, &text))
        .await
        .map_err(|e| e.to_string())?
}

/// Atomic save: write a temp file in the same directory, then rename over the
/// target, so a crash or full disk mid-write can never truncate the file.
fn write_file_impl(path: &str, text: &str) -> Result<(), String> {
    // Write through symlinks rather than replacing the link itself.
    let target: PathBuf = std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
    let dir = target
        .parent()
        .ok_or_else(|| "invalid path: no parent directory".to_string())?;
    let file_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let tmp = dir.join(format!(".{file_name}.vibe-studio.tmp"));

    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    // Preserve the original file's permissions (fresh temp files get defaults).
    if let Ok(meta) = std::fs::metadata(&target) {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }
    std::fs::rename(&tmp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

// ---------------------------------------------------------------------------
// Explorer file management
// ---------------------------------------------------------------------------

/// Last path segment, for error messages (io errors don't name the file).
fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

fn op_err(path: &str, e: std::io::Error) -> String {
    format!("{}: {e}", file_name(path))
}

#[tauri::command]
pub async fn fs_create_file(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        // create_new: never truncate something that already exists
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map(|_| ())
            .map_err(|e| op_err(&path, e))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fs_create_dir(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir(&path).map_err(|e| op_err(&path, e))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fs_rename(from: String, to: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || rename_impl(&from, &to))
        .await
        .map_err(|e| e.to_string())?
}

/// Rename/move that refuses to overwrite (std::fs::rename silently replaces
/// an existing file). Case-only renames are allowed: on the default
/// case-insensitive APFS the "existing" target is the source itself.
fn rename_impl(from: &str, to: &str) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    if let Ok(dest) = std::fs::symlink_metadata(to) {
        let same_file = std::fs::symlink_metadata(from)
            .map(|src| src.dev() == dest.dev() && src.ino() == dest.ino())
            .unwrap_or(false);
        if !same_file {
            return Err(format!("\"{}\" already exists", file_name(to)));
        }
    }
    std::fs::rename(from, to).map_err(|e| op_err(from, e))
}

#[tauri::command]
pub async fn fs_trash(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || trash_impl(&path))
        .await
        .map_err(|e| e.to_string())?
}

/// Move to the macOS Trash (recoverable, unlike fs::remove_*) via
/// NSFileManager — works for files and directories, no Finder automation
/// prompt. NSFileManager's shared instance is thread-safe for this.
fn trash_impl(path: &str) -> Result<(), String> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    NSFileManager::defaultManager()
        .trashItemAtURL_resultingItemURL_error(&url, None)
        .map_err(|e| e.localizedDescription().to_string())
}

#[tauri::command]
pub async fn fs_copy(src: String, dest_dir: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || copy_impl(&src, &dest_dir))
        .await
        .map_err(|e| e.to_string())?
}

/// Copy `src` into `dest_dir`, uniquifying the name Finder-style
/// ("name copy.ext", "name copy 2.ext", ...) when it already exists there.
/// Returns the created path.
fn copy_impl(src: &str, dest_dir: &str) -> Result<String, String> {
    let src_path = Path::new(src);
    // recursing into the fresh copy would never terminate
    if Path::new(dest_dir).starts_with(src_path) {
        return Err("cannot copy a folder into itself".to_string());
    }
    let name = src_path
        .file_name()
        .ok_or_else(|| "invalid source path".to_string())?
        .to_string_lossy()
        .into_owned();
    let dest = unique_dest(Path::new(dest_dir), &name);
    copy_recursive(src_path, &dest).map_err(|e| op_err(src, e))?;
    Ok(dest.to_string_lossy().into_owned())
}

/// First free path for `name` in `dir`: the name itself, then
/// "stem copy.ext", "stem copy 2.ext", ... (extension preserved).
fn unique_dest(dir: &Path, name: &str) -> PathBuf {
    // symlink_metadata: broken symlinks still occupy the name
    let exists = |p: &Path| std::fs::symlink_metadata(p).is_ok();
    let first = dir.join(name);
    if !exists(&first) {
        return first;
    }
    let stem = Path::new(name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_string());
    let ext = Path::new(name)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for n in 1.. {
        let candidate = if n == 1 {
            dir.join(format!("{stem} copy{ext}"))
        } else {
            dir.join(format!("{stem} copy {n}{ext}"))
        };
        if !exists(&candidate) {
            return candidate;
        }
    }
    unreachable!()
}

/// Depth-first copy. Symlinks are recreated as links (not followed) so
/// copying a directory can't blow up on link cycles or huge link targets.
fn copy_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    let ft = std::fs::symlink_metadata(src)?.file_type();
    if ft.is_symlink() {
        std::os::unix::fs::symlink(std::fs::read_link(src)?, dest)?;
    } else if ft.is_dir() {
        std::fs::create_dir(dest)?;
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &dest.join(entry.file_name()))?;
        }
    } else {
        std::fs::copy(src, dest)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn fs_reveal(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || reveal_impl(&path))
        .await
        .map_err(|e| e.to_string())?
}

/// Select the entry in a Finder window (`open -R`).
fn reveal_impl(path: &str) -> Result<(), String> {
    let status = std::process::Command::new("/usr/bin/open")
        .arg("-R")
        .arg(path)
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("could not reveal \"{}\" in Finder", file_name(path)))
    }
}

/// Open an external URL in the default app (markdown-preview links). The
/// scheme whitelist is the safety boundary: never hand arbitrary strings to
/// `open` (file:/smb:/vnc:… would reach well beyond the browser).
#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://")
        || lower.starts_with("http://")
        || lower.starts_with("mailto:"))
    {
        return Err("unsupported URL scheme".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let status = std::process::Command::new("/usr/bin/open")
            .arg(&url)
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err("could not open URL".to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
