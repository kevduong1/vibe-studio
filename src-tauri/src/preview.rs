mod discovery;
mod url;

#[tauri::command]
pub(crate) async fn preview_servers(
    workspace_path: String,
) -> Result<Vec<discovery::PreviewServer>, String> {
    tauri::async_runtime::spawn_blocking(move || discovery::discover(&workspace_path))
        .await
        .map_err(|e| format!("Preview discovery task failed: {e}"))?
}
