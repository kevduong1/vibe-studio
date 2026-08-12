// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod fsops;
mod agent_sessions;
mod control;
mod git;
mod lsp;
mod memories;
mod notify;
mod preview;
mod pty;
mod search;
mod usage;
mod watcher;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::PtyState::default())
        .manage(control::ControlState::default())
        .manage(lsp::LspState::default())
        .manage(watcher::WatcherState::default())
        .setup(|app| {
            if let Err(error) = control::start(app.handle(), &app.state::<control::ControlState>())
            {
                eprintln!("agent control socket unavailable: {error}");
            }
            Ok(())
        })
        // A page (re)load loses all frontend terminal and LSP-client state
        // (dev HMR full reload): kill the now-unreachable sessions instead
        // of leaking them — a flow-parked PTY reader would otherwise never
        // be acked again and freeze its child mid-write, and live language
        // servers would be unreachable garbage. No-op on the initial load.
        .on_page_load(|webview, payload| {
            if webview.label() == "main"
                && payload.event() == tauri::webview::PageLoadEvent::Started
            {
                notify::notification_activation_not_ready();
                pty::kill_all(&webview.app_handle().state::<pty::PtyState>());
                lsp::kill_all(&webview.app_handle().state::<lsp::LspState>());
            }
        })
        .invoke_handler(tauri::generate_handler![
            // git
            git::git_open,
            git::git_worktree_list,
            git::git_worktree_open,
            git::git_worktree_create,
            git::git_worktree_remove,
            git::git_worktree_merge,
            git::git_review_head,
            git::git_review_snapshot,
            git::git_checkpoint_snapshot,
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
            // privacy-bounded native agent session metadata
            agent_sessions::codex_native_session_candidates,
            agent_sessions::codex_native_session_exists,
            control::agent_control_sync,
            control::agent_control_respond,
            control::agent_control_commit,
            control::agent_control_info,
            // fs
            fsops::fs_read_dir,
            fsops::fs_read_file,
            fsops::fs_write_file,
            fsops::fs_create_file,
            fsops::fs_create_dir,
            fsops::fs_rename,
            fsops::fs_trash,
            fsops::fs_copy,
            fsops::fs_reveal,
            fsops::open_url,
            // search
            search::list_workspace_files,
            search::search_workspace,
            // previews
            preview::preview_servers,
            preview::webviews::preview_create,
            preview::webviews::preview_navigate,
            preview::webviews::preview_back,
            preview::webviews::preview_forward,
            preview::webviews::preview_reload,
            preview::webviews::preview_set_bounds,
            preview::webviews::preview_set_visible,
            preview::webviews::preview_focus,
            preview::webviews::preview_close,
            preview::webviews::preview_close_many,
            // watcher
            watcher::watch_repo,
            watcher::unwatch_repo,
            // pty
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_ack,
            pty::pty_kill,
            pty::pty_agent_process_snapshot,
            pty::executable_version,
            // lsp
            lsp::lsp_resolve,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            // notify
            notify::notification_state,
            notify::notification_request,
            notify::notification_send,
            notify::notification_activation_ready,
            notify::notification_dismiss,
            notify::play_sound,
            // usage
            usage::claude_usage,
            usage::codex_usage,
            // memories
            memories::memories_list,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Normal quit (⌘Q): explicitly tear down child processes instead
            // of relying on their own parent-death handling (stdin EOF /
            // initialize-processId watch — which still backstop the crash
            // and force-quit paths this callback never sees). PTY teardown is
            // SYNCHRONOUS here: this callback returns straight into process
            // exit, so the off-thread SIGKILL escalation kill_all uses would
            // never fire and dev servers (in their own job-control process
            // groups) would survive. LSP servers self-exit on stdin EOF, so
            // their async kill is fine.
            if let tauri::RunEvent::Exit = event {
                control::stop(&app_handle.state::<control::ControlState>());
                preview::close_all(app_handle);
                pty::kill_all_blocking(&app_handle.state::<pty::PtyState>());
                lsp::kill_all(&app_handle.state::<lsp::LspState>());
            }
        });
}
