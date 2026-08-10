use super::{PreviewBounds, PreviewExternalEvent, PreviewLoadEvent};
use crate::preview::url::{is_loopback_url, normalize_loopback_url};
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, Position, Rect, Size,
    Webview, WebviewUrl,
};

fn webview_label(id: &str) -> Result<&str, String> {
    let uuid = id
        .strip_prefix("preview:")
        .ok_or_else(|| "Invalid preview ID".to_string())?;
    let valid = uuid.len() == 36
        && uuid.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        });
    if valid {
        Ok(id)
    } else {
        Err("Invalid preview ID".into())
    }
}

fn validate_bounds(bounds: PreviewBounds) -> Result<(), String> {
    if bounds.x.is_finite()
        && bounds.y.is_finite()
        && bounds.width.is_finite()
        && bounds.height.is_finite()
        && bounds.width > 0.0
        && bounds.height > 0.0
        && bounds.page_zoom.is_finite()
        && bounds.page_zoom > 0.0
    {
        Ok(())
    } else {
        Err("Preview bounds must be finite with a positive size".into())
    }
}

fn preview_webview(app: &AppHandle, id: &str) -> Result<Webview, String> {
    let label = webview_label(id)?;
    app.get_webview(label)
        .ok_or_else(|| format!("Preview webview not found: {label}"))
}

fn logical_position(bounds: PreviewBounds) -> LogicalPosition<f64> {
    LogicalPosition::new(bounds.x, bounds.y)
}

fn logical_size(bounds: PreviewBounds) -> LogicalSize<f64> {
    LogicalSize::new(bounds.width, bounds.height)
}

fn logical_rect(bounds: PreviewBounds) -> Rect {
    Rect {
        position: Position::Logical(logical_position(bounds)),
        size: Size::Logical(logical_size(bounds)),
    }
}

fn emit_external(app: &AppHandle, id: &str, url: &url::Url) {
    let _ = app.emit_to(
        EventTarget::webview("main"),
        "preview-external",
        PreviewExternalEvent {
            id: id.to_string(),
            url: url.to_string(),
        },
    );
}

fn is_allowed_top_level_url(url: &url::Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && is_loopback_url(url)
        && url.username().is_empty()
        && url.password().is_none()
}

fn hide_or_rollback(
    hide: impl FnOnce() -> Result<(), String>,
    rollback: impl FnOnce(),
) -> Result<(), String> {
    if let Err(error) = hide() {
        rollback();
        Err(error)
    } else {
        Ok(())
    }
}

#[tauri::command]
pub(crate) fn preview_create(
    app: AppHandle,
    id: String,
    url: String,
    bounds: PreviewBounds,
) -> Result<(), String> {
    let label = webview_label(&id)?.to_string();
    let url = normalize_loopback_url(&url)?;
    validate_bounds(bounds)?;

    if app.get_webview(&label).is_some() {
        return Ok(());
    }

    let window = app
        .get_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    let navigation_app = app.clone();
    let navigation_id = id.clone();
    let new_window_app = app.clone();
    let new_window_id = id.clone();
    let new_window_label = label.clone();
    let load_app = app.clone();
    let load_id = id.clone();
    let builder = WebviewBuilder::new(label, WebviewUrl::External(url))
        .on_navigation(move |url| {
            if is_allowed_top_level_url(url) {
                true
            } else {
                emit_external(&navigation_app, &navigation_id, url);
                false
            }
        })
        .on_new_window(move |url, _features| {
            if is_allowed_top_level_url(&url) {
                if let Some(webview) = new_window_app.get_webview(&new_window_label) {
                    let _ = webview.navigate(url);
                }
            } else {
                emit_external(&new_window_app, &new_window_id, &url);
            }
            NewWindowResponse::Deny
        })
        .on_page_load(move |_webview, payload| {
            let phase = match payload.event() {
                PageLoadEvent::Started => "started",
                PageLoadEvent::Finished => "finished",
            };
            let _ = load_app.emit_to(
                EventTarget::webview("main"),
                "preview-load",
                PreviewLoadEvent {
                    id: load_id.clone(),
                    url: payload.url().to_string(),
                    phase,
                },
            );
        });

    let webview = window
        .add_child(builder, logical_position(bounds), logical_size(bounds))
        .map_err(|error| error.to_string())?;
    hide_or_rollback(
        || webview.hide().map_err(|error| error.to_string()),
        || {
            let _ = webview.close();
        },
    )?;
    if let Err(error) = webview.set_zoom(bounds.page_zoom) {
        let _ = webview.close();
        return Err(error.to_string());
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn preview_navigate(app: AppHandle, id: String, url: String) -> Result<(), String> {
    let url = normalize_loopback_url(&url)?;
    preview_webview(&app, &id)?
        .navigate(url)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn preview_back(app: AppHandle, id: String) -> Result<(), String> {
    preview_webview(&app, &id)?
        .eval("history.back()")
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn preview_forward(app: AppHandle, id: String) -> Result<(), String> {
    preview_webview(&app, &id)?
        .eval("history.forward()")
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn preview_reload(app: AppHandle, id: String) -> Result<(), String> {
    preview_webview(&app, &id)?
        .eval("location.reload()")
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn preview_set_bounds(
    app: AppHandle,
    id: String,
    bounds: PreviewBounds,
) -> Result<(), String> {
    validate_bounds(bounds)?;
    let label = webview_label(&id)?;
    let Some(webview) = app.get_webview(label) else {
        return Ok(());
    };
    webview
        .set_bounds(logical_rect(bounds))
        .map_err(|error| error.to_string())?;
    webview
        .set_zoom(bounds.page_zoom)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn preview_set_visible(app: AppHandle, id: String, visible: bool) -> Result<(), String> {
    let label = webview_label(&id)?;
    let Some(webview) = app.get_webview(label) else {
        return if visible {
            Err(format!("Preview webview not found: {label}"))
        } else {
            Ok(())
        };
    };
    let result = if visible {
        webview.show()
    } else {
        webview.hide()
    };
    result.map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn preview_focus(app: AppHandle, id: String) -> Result<(), String> {
    let label = webview_label(&id)?;
    let Some(webview) = app.get_webview(label) else {
        return Ok(());
    };
    webview.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn preview_close(app: AppHandle, id: String) -> Result<(), String> {
    let label = webview_label(&id)?;
    if let Some(webview) = app.get_webview(label) {
        webview.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn preview_close_many(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    let mut first_error = None;
    for id in ids {
        if let Err(error) = preview_close(app.clone(), id) {
            if first_error.is_none() {
                first_error = Some(error);
            }
        }
    }
    first_error.map_or(Ok(()), Err)
}

pub(crate) fn close_all(app: &AppHandle) {
    for (label, webview) in app.webviews() {
        if label.starts_with("preview:") {
            let _ = webview.close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn accepts_only_generated_preview_ids() {
        assert_eq!(
            webview_label("preview:550e8400-e29b-41d4-a716-446655440000").unwrap(),
            "preview:550e8400-e29b-41d4-a716-446655440000"
        );
        assert!(webview_label("main").is_err());
        assert!(webview_label("preview:../bad").is_err());
    }

    #[test]
    fn rejects_non_finite_or_empty_bounds() {
        assert!(validate_bounds(PreviewBounds {
            x: 1.0,
            y: 2.0,
            width: 390.0,
            height: 844.0,
            page_zoom: 1.0,
        })
        .is_ok());
        assert!(validate_bounds(PreviewBounds {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 844.0,
            page_zoom: 1.0,
        })
        .is_err());
        assert!(validate_bounds(PreviewBounds {
            x: f64::NAN,
            y: 0.0,
            width: 390.0,
            height: 844.0,
            page_zoom: 1.0,
        })
        .is_err());
        assert!(validate_bounds(PreviewBounds {
            x: 0.0,
            y: 0.0,
            width: 390.0,
            height: 844.0,
            page_zoom: 0.0,
        })
        .is_err());
    }

    #[test]
    fn closes_new_webview_when_initial_hide_fails() {
        let closed = Cell::new(false);

        let result = hide_or_rollback(|| Err("hide failed".to_string()), || closed.set(true));

        assert_eq!(result.unwrap_err(), "hide failed");
        assert!(closed.get());
    }

    #[test]
    fn allows_only_credential_free_loopback_http_urls_for_top_level_navigation() {
        for allowed in [
            "http://localhost:3000/app",
            "https://127.0.0.1:4443/path",
            "http://[::1]:8081/",
        ] {
            let url = url::Url::parse(allowed).unwrap();
            assert!(is_allowed_top_level_url(&url), "{allowed}");
        }

        for rejected in [
            "tauri://localhost/app",
            "ftp://localhost/app",
            "http://user:pass@localhost:3000/app",
        ] {
            let url = url::Url::parse(rejected).unwrap();
            assert!(!is_allowed_top_level_url(&url), "{rejected}");
        }
    }
}
