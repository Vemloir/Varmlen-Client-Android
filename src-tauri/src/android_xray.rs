//! Launches Xray on Android while preserving the TUN descriptor created by VpnService.
//!
//! Android's Java ProcessBuilder closes descriptors above stderr before exec, even when
//! FD_CLOEXEC has been cleared. Spawning from Rust lets a `dup()` of the VpnService fd
//! survive exec and be consumed by Xray's native TUN inbound through `XRAY_TUN_FD`.

use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::Duration;

use jni::objects::{JClass, JString};
use jni::sys::{jboolean, jint};
use jni::JNIEnv;

const STARTUP_GRACE: Duration = Duration::from_millis(500);
const MAX_LOG_BYTES: u64 = 8 * 1024 * 1024;
const ROTATED_LOG_FILES: usize = 3;

struct CoreProcess {
    child: Child,
    log_threads: Vec<JoinHandle<()>>,
}

static CORE: Mutex<Option<CoreProcess>> = Mutex::new(None);
static LOG_LOCK: Mutex<()> = Mutex::new(());

fn core() -> MutexGuard<'static, Option<CoreProcess>> {
    CORE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn read(env: &mut JNIEnv, value: &JString) -> Option<String> {
    env.get_string(value).ok().map(Into::into)
}

fn stop_core(slot: &mut Option<CoreProcess>) {
    if let Some(mut process) = slot.take() {
        let _ = process.child.kill();
        let _ = process.child.wait();
        for thread in process.log_threads {
            let _ = thread.join();
        }
    }
}

fn spawn_log_pump<R>(mut reader: R, log_path: PathBuf) -> JoinHandle<()>
where
    R: Read + Send + 'static,
{
    std::thread::spawn(move || {
        let store = crate::bounded_log::BoundedLog::new(log_path, MAX_LOG_BYTES, ROTATED_LOG_FILES);
        let mut buffer = [0_u8; 8192];
        loop {
            let count = match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => count,
            };
            let _guard = LOG_LOCK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if store.append(&buffer[..count]).is_err() {
                break;
            }
        }
    })
}

#[no_mangle]
pub extern "system" fn Java_app_varmlen_client_XrayCore_start(
    mut env: JNIEnv,
    _class: JClass,
    binary: JString,
    config: JString,
    asset_dir: JString,
    log_path: JString,
    tun_fd: jint,
) -> jboolean {
    let (Some(binary), Some(config), Some(asset_dir), Some(log_path)) = (
        read(&mut env, &binary),
        read(&mut env, &config),
        read(&mut env, &asset_dir),
        read(&mut env, &log_path),
    ) else {
        return 0;
    };

    let mut slot = core();
    stop_core(&mut slot);

    // dup() returns a descriptor with FD_CLOEXEC cleared. Rust's native process
    // launcher leaves that descriptor open across exec, unlike Java ProcessBuilder.
    let inherited_fd = unsafe { libc::dup(tun_fd) };
    if inherited_fd < 0 {
        return 0;
    }

    let spawned = Command::new(binary)
        .arg("run")
        .arg("-c")
        .arg(config)
        .current_dir(&asset_dir)
        .env("XRAY_TUN_FD", inherited_fd.to_string())
        .env("XRAY_LOCATION_ASSET", asset_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    // The child received its own descriptor during spawn. Keeping the parent's
    // duplicate open would prevent ParcelFileDescriptor.close() from retiring TUN.
    unsafe { libc::close(inherited_fd) };

    let Ok(mut child) = spawned else {
        return 0;
    };
    let mut log_threads = Vec::with_capacity(2);
    if let Some(stdout) = child.stdout.take() {
        log_threads.push(spawn_log_pump(stdout, PathBuf::from(&log_path)));
    }
    if let Some(stderr) = child.stderr.take() {
        log_threads.push(spawn_log_pump(stderr, PathBuf::from(&log_path)));
    }

    std::thread::sleep(STARTUP_GRACE);
    if matches!(child.try_wait(), Ok(Some(_)) | Err(_)) {
        let _ = child.wait();
        for thread in log_threads {
            let _ = thread.join();
        }
        return 0;
    }

    *slot = Some(CoreProcess { child, log_threads });
    1
}

/// Runs `xray run -test -c <config>` synchronously and returns whether the
/// device-free preflight config is structurally valid. Called by Kotlin
/// BEFORE the candidate config is ever allowed to
/// establish the TUN or replace the active tunnel (see android_xray_config /
/// android-xray-validate flow in `vpn.rs`/`VarmlenVpnService.kt`). Any
/// failure text goes to `log_path` so it's visible in the in-app log.
#[no_mangle]
pub extern "system" fn Java_app_varmlen_client_XrayCore_validate(
    mut env: JNIEnv,
    _class: JClass,
    binary: JString,
    config: JString,
    log_path: JString,
) -> jboolean {
    let (Some(binary), Some(config), Some(log_path)) = (
        read(&mut env, &binary),
        read(&mut env, &config),
        read(&mut env, &log_path),
    ) else {
        return 0;
    };

    let output = Command::new(&binary)
        .arg("run")
        .arg("-test")
        .arg("-c")
        .arg(&config)
        .output();

    match output {
        Ok(out) if out.status.success() => 1,
        Ok(out) => {
            let mut msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
            if msg.is_empty() {
                msg = String::from_utf8_lossy(&out.stdout).trim().to_string();
            }
            append_log(&log_path, &format!("xray config validation failed: {msg}"));
            0
        }
        Err(e) => {
            append_log(&log_path, &format!("xray config validation error: {e}"));
            0
        }
    }
}

fn append_log(path: &str, line: &str) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let entry = format!("[{ts}] {line}\n");
    let _guard = LOG_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _ =
        crate::bounded_log::BoundedLog::new(PathBuf::from(path), MAX_LOG_BYTES, ROTATED_LOG_FILES)
            .append(entry.as_bytes());
}

#[no_mangle]
pub extern "system" fn Java_app_varmlen_client_XrayCore_appendLog(
    mut env: JNIEnv,
    _class: JClass,
    log_path: JString,
    message: JString,
) {
    let (Some(log_path), Some(message)) = (read(&mut env, &log_path), read(&mut env, &message))
    else {
        return;
    };
    append_log(&log_path, &message);
}

#[no_mangle]
pub extern "system" fn Java_app_varmlen_client_XrayCore_isRunning(
    _env: JNIEnv,
    _class: JClass,
) -> jboolean {
    let mut slot = core();
    let running = match slot.as_mut() {
        Some(process) => matches!(process.child.try_wait(), Ok(None)),
        None => false,
    };
    if !running {
        if let Some(mut process) = slot.take() {
            let _ = process.child.wait();
            for thread in process.log_threads {
                let _ = thread.join();
            }
        }
    }
    running as jboolean
}

#[no_mangle]
pub extern "system" fn Java_app_varmlen_client_XrayCore_stop(_env: JNIEnv, _class: JClass) {
    stop_core(&mut core());
}
