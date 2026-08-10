mod discovery;
mod url;
pub(crate) mod webviews;

pub(crate) use webviews::close_all;

#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub page_zoom: f64,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewLoadEvent {
    pub id: String,
    pub url: String,
    pub phase: &'static str,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewExternalEvent {
    pub id: String,
    pub url: String,
}

#[tauri::command]
pub(crate) async fn preview_servers(
    workspace_path: String,
) -> Result<Vec<discovery::PreviewServer>, String> {
    tauri::async_runtime::spawn_blocking(move || discovery::discover(&workspace_path))
        .await
        .map_err(|e| format!("Preview discovery task failed: {e}"))?
}
