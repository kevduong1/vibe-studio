//! Attention alerts: system banners via the modern UserNotifications
//! framework, plus app-played sounds via `afplay`.
//!
//! Banners deliberately do NOT go through tauri-plugin-notification: its
//! desktop path posts with the deprecated NSUserNotificationCenter API,
//! which current macOS accepts but never presents (verified empirically:
//! every post lands in deliveredNotifications with `presented = NO`) and
//! which cannot register the app with Notification Center — no System
//! Settings entry, no authorization prompt, no banner, ever. The UN
//! framework fixes all of that but requires a real app bundle, so the
//! banner commands report/behave as "unsupported" under bare `tauri dev`
//! (no bundle identifier). UNUserNotificationCenter is thread-safe, so
//! everything runs on the blocking pool like every other command.
//!
//! Foreground presentation: the UN framework SILENTLY suppresses banners
//! while the app is frontmost unless a delegate's `willPresentNotification`
//! grants presentation — and agent attention usually fires exactly then
//! (the heuristic is pane focus, not app focus). `notification_send` hence
//! installs a retained delegate and carries a `present_foreground` flag
//! (the settings-modal "Show banners" mode) that the delegate answers with.
//!
//! Sound is decoupled from the banner on purpose: `play_sound` plays any
//! audio file through `afplay`, which works identically in dev and release
//! and is unaffected by Focus modes or per-app notification settings.

use std::path::Path;
use std::process::Stdio;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, OnceLock};
use std::time::Duration;

use block2::{DynBlock, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, AnyThread};
use objc2_foundation::{NSArray, NSBundle, NSError, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNNotificationSettings, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use parking_lot::Mutex;
use tauri::{Emitter, Manager};

/// Permission state as the frontend sees it. "unsupported" = the process has
/// no bundle identifier (bare `tauri dev`), where the UN framework would
/// throw before reaching any authorization logic.
const GRANTED: &str = "granted";
const DENIED: &str = "denied";
const PROMPT: &str = "prompt";
const UNSUPPORTED: &str = "unsupported";
const NOTIFICATION_ACCEPT_TIMEOUT: Duration = Duration::from_secs(5);

/// Run UN-framework / process work on the blocking pool so it never stalls
/// the async runtime (which also serves terminal IPC) — git.rs convention.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

/// UNUserNotificationCenter aborts the process (ObjC exception) when the
/// running binary has no bundle — gate every UN touch behind this.
fn has_bundle() -> bool {
    NSBundle::mainBundle().bundleIdentifier().is_some()
}

fn status_str(status: UNAuthorizationStatus) -> &'static str {
    match status {
        UNAuthorizationStatus::NotDetermined => PROMPT,
        UNAuthorizationStatus::Denied => DENIED,
        // Authorized | Provisional | Ephemeral all deliver.
        _ => GRANTED,
    }
}

/// Frontmost-app presentation policy, latched from the most recent
/// `notification_send` (the frontend owns the persisted setting and passes
/// it with every post — no extra command, no second source of truth).
static PRESENT_FOREGROUND: AtomicBool = AtomicBool::new(false);

#[derive(Default)]
struct ActivationState {
    frontend_ready: bool,
    pending: Option<String>,
}

static ACTIVATION: Mutex<ActivationState> = Mutex::new(ActivationState {
    frontend_ready: false,
    pending: None,
});
static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NotificationActivation {
    terminal_id: String,
}

fn deliver_activation(id: String) {
    let Some(app) = APP_HANDLE.get() else {
        ACTIVATION.lock().pending = Some(id);
        return;
    };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    let mut state = ACTIVATION.lock();
    if state.frontend_ready {
        drop(state);
        let _ = app.emit(
            "notification-activation",
            NotificationActivation { terminal_id: id },
        );
    } else {
        state.pending = Some(id);
    }
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements; the delegate is
    // stateless (no ivars, no Drop) and callable from any thread.
    #[unsafe(super(NSObject))]
    #[name = "VibeStudioNotifyDelegate"]
    struct NotifyDelegate;

    unsafe impl NSObjectProtocol for NotifyDelegate {}

    unsafe impl UNUserNotificationCenterDelegate for NotifyDelegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        #[allow(non_snake_case)] // mirrors the generated trait method name
        fn userNotificationCenter_willPresentNotification_withCompletionHandler(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            let opts = if PRESENT_FOREGROUND.load(Ordering::Relaxed) {
                UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List
            } else {
                UNNotificationPresentationOptions::empty()
            };
            completion.call((opts,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        #[allow(non_snake_case)]
        fn userNotificationCenter_didReceiveNotificationResponse_withCompletionHandler(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion: &DynBlock<dyn Fn()>,
        ) {
            let id = response.notification().request().identifier().to_string();
            deliver_activation(id);
            completion.call(());
        }
    }
);

/// The center holds its delegate WEAKLY — this cell retains it for the
/// process lifetime. SAFETY: the delegate is stateless; the cell exists
/// only to keep the ObjC object alive across threads.
struct DelegateCell(#[allow(dead_code)] Retained<NotifyDelegate>);
unsafe impl Send for DelegateCell {}
unsafe impl Sync for DelegateCell {}
static DELEGATE: OnceLock<DelegateCell> = OnceLock::new();

/// Install the willPresent delegate (once, before the first post — delivery
/// is async, so a synchronous set here always wins the race).
fn ensure_delegate(center: &UNUserNotificationCenter) {
    DELEGATE.get_or_init(|| {
        let delegate: Retained<NotifyDelegate> =
            unsafe { msg_send![NotifyDelegate::alloc(), init] };
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        DelegateCell(delegate)
    });
}

#[tauri::command]
pub async fn notification_state() -> Result<String, String> {
    blocking(|| {
        if !has_bundle() {
            return Ok(UNSUPPORTED.to_string());
        }
        let (tx, rx) = mpsc::channel();
        unsafe {
            let center = UNUserNotificationCenter::currentNotificationCenter();
            let block = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
                let _ = tx.send(settings.as_ref().authorizationStatus());
            });
            center.getNotificationSettingsWithCompletionHandler(&block);
        }
        // Timeout is an ERROR, not "unsupported" — conflating a hung
        // settings query with the no-bundle dev state would silently skip
        // the one-time authorization request on a bundled build.
        rx.recv_timeout(Duration::from_secs(5))
            .map(|s| status_str(s).to_string())
            .map_err(|_| "notification settings query timed out".to_string())
    })
    .await
}

#[tauri::command]
pub async fn notification_request() -> Result<String, String> {
    blocking(|| {
        if !has_bundle() {
            return Ok(UNSUPPORTED.to_string());
        }
        let (tx, rx) = mpsc::channel();
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let block = RcBlock::new(move |granted: Bool, _error: *mut NSError| {
            let _ = tx.send(granted.as_bool());
        });
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &block,
        );
        // No timeout: the completion fires only once the user answers the
        // OS prompt, however long they ponder it.
        Ok(match rx.recv() {
            Ok(true) => GRANTED.to_string(),
            Ok(false) => DENIED.to_string(),
            Err(_) => UNSUPPORTED.to_string(),
        })
    })
    .await
}

/// Post a banner (no notification sound — the attention sound is
/// app-played via `play_sound`). `id` is the caller's stable key (terminal
/// id): the framework REPLACES a delivered notification when its identifier
/// is reused, capping pile-up at one live banner per terminal, and it's the
/// handle `notification_dismiss` removes by. `present_foreground` is the
/// settings-modal "Show banners" policy: whether the delegate presents
/// while the app is frontmost. Unauthorized posts are rejected by the
/// framework; dev (no bundle) is a silent no-op. The command resolves after
/// Notification Center accepts/rejects the request or after a bounded timeout
/// withdraws it, allowing the frontend to serialize a later dismissal without
/// parking that identifier's operation queue indefinitely.
#[tauri::command]
pub async fn notification_send(
    app: tauri::AppHandle,
    id: String,
    title: String,
    body: String,
    present_foreground: bool,
) -> Result<(), String> {
    let _ = APP_HANDLE.set(app);
    blocking(move || {
        if !has_bundle() {
            return Ok(());
        }
        PRESENT_FOREGROUND.store(present_foreground, Ordering::Relaxed);
        let center = UNUserNotificationCenter::currentNotificationCenter();
        ensure_delegate(&center);
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&title));
        content.setBody(&NSString::from_str(&body));
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(&id),
            &content,
            None,
        );
        let (tx, rx) = mpsc::channel();
        let timed_out = Arc::new(AtomicBool::new(false));
        let completion_timed_out = timed_out.clone();
        let completion_id = id.clone();
        let completion = RcBlock::new(move |error: *mut NSError| {
            // If the framework accepts after our bounded wait, remove again at
            // completion. Together with the immediate timeout removal below,
            // this closes both sides of the timeout/acceptance race.
            if completion_timed_out.load(Ordering::Acquire) {
                let ids = NSArray::from_retained_slice(&[NSString::from_str(&completion_id)]);
                let center = UNUserNotificationCenter::currentNotificationCenter();
                center.removePendingNotificationRequestsWithIdentifiers(&ids);
                center.removeDeliveredNotificationsWithIdentifiers(&ids);
            }
            let _ = tx.send(error.is_null());
        });
        center.addNotificationRequest_withCompletionHandler(&request, Some(&completion));
        match rx.recv_timeout(NOTIFICATION_ACCEPT_TIMEOUT) {
            Ok(true) => Ok(()),
            Ok(false) => Err("notification request was rejected".to_string()),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                timed_out.store(true, Ordering::Release);
                let ids = NSArray::from_retained_slice(&[NSString::from_str(&id)]);
                center.removePendingNotificationRequestsWithIdentifiers(&ids);
                center.removeDeliveredNotificationsWithIdentifiers(&ids);
                Err("notification request acceptance timed out and was withdrawn".to_string())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err("notification request completion channel closed".to_string())
            }
        }
    })
    .await
}

/// Called only after the frontend listener is installed. Flushes the one
/// activation that may have arrived during startup/listener registration.
#[tauri::command]
pub fn notification_activation_ready(app: tauri::AppHandle) -> Result<(), String> {
    let _ = APP_HANDLE.set(app.clone());
    let pending = {
        let mut state = ACTIVATION.lock();
        state.frontend_ready = true;
        state.pending.take()
    };
    if let Some(terminal_id) = pending {
        app.emit(
            "notification-activation",
            NotificationActivation { terminal_id },
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Page reload tears down the JS listener before the next page can install
/// it. The composition root calls this at main-page load start.
pub fn notification_activation_not_ready() {
    ACTIVATION.lock().frontend_ready = false;
}

#[cfg(test)]
mod activation_tests {
    use super::ActivationState;

    #[test]
    fn pending_activation_keeps_latest_terminal() {
        let mut state = ActivationState {
            pending: Some("first".into()),
            ..Default::default()
        };
        state.pending = Some("second".into());
        assert_eq!(state.pending.as_deref(), Some("second"));
        state.frontend_ready = true;
        assert_eq!(state.pending.take().as_deref(), Some("second"));
        assert!(state.pending.is_none());
    }
}

/// Remove pending and delivered banners under this identifier (attention was
/// answered, the terminal closed, or notifications were disabled). Delivery
/// is asynchronous, so removing only the delivered set can let an already
/// accepted request appear after dismissal. Missing identifiers are a
/// framework no-op, as is dev (no bundle).
#[tauri::command]
pub async fn notification_dismiss(id: String) -> Result<(), String> {
    blocking(move || {
        if !has_bundle() {
            return Ok(());
        }
        let ids = NSArray::from_retained_slice(&[NSString::from_str(&id)]);
        let center = UNUserNotificationCenter::currentNotificationCenter();
        center.removePendingNotificationRequestsWithIdentifiers(&ids);
        center.removeDeliveredNotificationsWithIdentifiers(&ids);
        Ok(())
    })
    .await
}

/// The currently-playing afplay pid: a new sound PREEMPTS the previous one
/// (stacked alerts are noise, and a long custom file would otherwise be
/// unstoppable). Reapers compare-and-clear their own pid after waiting.
static PLAYING: Mutex<Option<u32>> = Mutex::new(None);

/// Play an audio file (any format afplay handles: aiff/wav/mp3/m4a...).
/// A missing file is an Err so callers can fall back to the bundled default
/// (the realistic failure: a stored custom path whose file was deleted or
/// whose volume unmounted). A corrupt file still just plays nothing —
/// afplay exits nonzero, which nobody waits on; the reaper thread exists
/// solely to avoid zombies and clear the preemption slot.
#[tauri::command]
pub async fn play_sound(path: String) -> Result<(), String> {
    blocking(move || {
        if !Path::new(&path).is_file() {
            return Err(format!("no such audio file: {path}"));
        }
        let mut child = std::process::Command::new("/usr/bin/afplay")
            .arg(&path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("afplay: {e}"))?;
        let pid = child.id();
        if let Some(prev) = PLAYING.lock().replace(pid) {
            // One attention sound at a time. An already-exited prev is a
            // zombie until its reaper runs (kill = harmless no-op); the
            // reaped-but-not-yet-cleared window is microseconds — the same
            // kill-by-pid race pty.rs accepts.
            unsafe { libc::kill(prev as i32, libc::SIGTERM) };
        }
        std::thread::spawn(move || {
            let _ = child.wait();
            let mut slot = PLAYING.lock();
            if *slot == Some(pid) {
                *slot = None;
            }
        });
        Ok(())
    })
    .await
}
