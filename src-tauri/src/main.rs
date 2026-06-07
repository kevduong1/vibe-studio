// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod fsops;
mod git;
mod lsp;
mod pty;
mod search;
mod watcher;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(pty::PtyState::default())
        .manage(lsp::LspState::default())
        .manage(watcher::WatcherState::default())
        // A page (re)load loses all frontend terminal and LSP-client state
        // (dev HMR full reload): kill the now-unreachable sessions instead
        // of leaking them — a flow-parked PTY reader would otherwise never
        // be acked again and freeze its child mid-write, and live language
        // servers would be unreachable garbage. No-op on the initial load.
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                pty::kill_all(&webview.app_handle().state::<pty::PtyState>());
                lsp::kill_all(&webview.app_handle().state::<lsp::LspState>());
            }
        })
        .invoke_handler(tauri::generate_handler![
            // git
            git::git_open,
            git::git_status,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_commit,
            git::git_log,
            git::git_commit_files,
            git::git_diff_file,
            git::git_stash_list,
            git::git_stash_save,
            git::git_stash_apply,
            git::git_stash_pop,
            git::git_stash_drop,
            git::git_fetch,
            git::git_pull,
            git::git_push,
            git::git_checkout,
            git::git_create_branch,
            git::git_squash,
            git::git_rebase,
            git::git_reset,
            git::git_cherry_pick,
            git::git_list_refs,
            git::git_generate_commit_message,
            // fs
            fsops::fs_read_dir,
            fsops::fs_read_file,
            fsops::fs_write_file,
            // search
            search::list_workspace_files,
            search::search_workspace,
            // watcher
            watcher::watch_repo,
            watcher::unwatch_repo,
            // pty
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_ack,
            pty::pty_kill,
            // lsp
            lsp::lsp_resolve,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Normal quit (⌘Q): explicitly tear down child processes instead
            // of relying on their own parent-death handling (stdin EOF /
            // initialize-processId watch — which still backstop the crash
            // and force-quit paths this callback never sees).
            if let tauri::RunEvent::Exit = event {
                pty::kill_all(&app_handle.state::<pty::PtyState>());
                lsp::kill_all(&app_handle.state::<lsp::LspState>());
            }
        });
}
