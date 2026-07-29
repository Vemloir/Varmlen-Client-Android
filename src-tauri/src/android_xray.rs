//! Launches Xray on Android while preserving the TUN descriptor created by VpnService.
//!
//! Android's Java ProcessBuilder closes descriptors above stderr before exec, even when
//! FD_CLOEXEC has been cleared. Spawning from Rust lets a `dup()` of the VpnService fd
//! survive exec and be consumed by Xray's native TUN inbound through `XRAY_TUN_FD`.

use std::fs::OpenOptions;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use jni::objects::{JClass, JString};
use jni::sys::{jboolean, jint};
use jni::JNIEnv;

const STARTUP_GRACE: Duration = Duration::from_millis(500);

static CORE: Mutex<Option<Child>> = Mutex::new(None);

fn core() -> MutexGuard<'static, Option<Child>> {
    CORE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn read(env: &mut JNIEnv, value: &JString) -> Option<String> {
    env.get_string(value).ok().map(Into::into)
}

fn stop_core(slot: &mut Option<Child>) {
    if let Some(mut child) = slot.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
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

    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .ok();
    let stdout = log
        .as_ref()
        .and_then(|file| file.try_clone().ok())
        .map(Stdio::from)
        .unwrap_or_else(Stdio::null);
    let stderr = log.map(Stdio::from).unwrap_or_else(Stdio::null);

    let spawned = Command::new(binary)
        .arg("run")
        .arg("-c")
        .arg(config)
        .current_dir(&asset_dir)
        .env("XRAY_TUN_FD", inherited_fd.to_string())
        .env("XRAY_LOCATION_ASSET", asset_dir)
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr)
        .spawn();

    // The child received its own descriptor during spawn. Keeping the parent's
    // duplicate open would prevent ParcelFileDescriptor.close() from retiring TUN.
    unsafe { libc::close(inherited_fd) };

    let Ok(mut child) = spawned else {
        return 0;
    };

    std::thread::sleep(STARTUP_GRACE);
    if matches!(child.try_wait(), Ok(Some(_)) | Err(_)) {
        let _ = child.wait();
        return 0;
    }

    *slot = Some(child);
    1
}

#[no_mangle]
pub extern "system" fn Java_app_varmlen_client_XrayCore_isRunning(
    _env: JNIEnv,
    _class: JClass,
) -> jboolean {
    let mut slot = core();
    let running = match slot.as_mut() {
        Some(child) => matches!(child.try_wait(), Ok(None)),
        None => false,
    };
    if !running {
        if let Some(mut child) = slot.take() {
            let _ = child.wait();
        }
    }
    running as jboolean
}

#[no_mangle]
pub extern "system" fn Java_app_varmlen_client_XrayCore_stop(_env: JNIEnv, _class: JClass) {
    stop_core(&mut core());
}
