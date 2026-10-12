mod ai;
mod askpass;
mod commands;
mod error;
mod github;
mod progress;
mod state;
mod update;
mod watcher;

#[cfg(debug_assertions)]
use specta_typescript::Typescript;
use tauri_specta::{Builder, collect_commands, collect_events};

use crate::state::AppState;

fn specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            // repositories
            commands::open_repository,
            commands::init_repository,
            commands::clone_repository,
            commands::cancel_operation,
            commands::close_repository,
            commands::refresh_repository,
            commands::repository_refs,
            commands::open_in_editor,
            commands::reveal_in_file_manager,
            // history
            commands::commit_count,
            commands::graph_rows,
            commands::commit_index,
            commands::search_commits,
            commands::commit_details,
            commands::commit_file_diff,
            commands::commit_file_contents,
            // working tree
            commands::working_tree_status,
            commands::stage_files,
            commands::unstage_files,
            commands::stage_all,
            commands::unstage_all,
            commands::stage_hunk,
            commands::unstage_hunk,
            commands::discard_files,
            commands::discard_all,
            commands::workdir_file_diff,
            commands::workdir_file_contents,
            commands::ignore_paths,
            commands::commit,
            // branches and tags
            commands::checkout,
            commands::checkout_commit,
            commands::create_branch,
            commands::rename_branch,
            commands::delete_branch,
            commands::delete_remote_branch,
            commands::push_branch,
            commands::set_upstream,
            commands::create_tag,
            commands::delete_tag,
            // merges and friends
            commands::merge,
            commands::rebase,
            commands::cherry_pick,
            commands::revert,
            commands::abort_operation,
            commands::continue_operation,
            commands::resolve_conflict,
            // stashes
            commands::stash_list,
            commands::stash_push,
            commands::stash_apply,
            commands::stash_pop,
            commands::stash_drop,
            // remotes
            commands::fetch,
            commands::fetch_in_background,
            commands::pull,
            commands::push,
            // GitHub
            github::github_account,
            github::github_sign_in,
            github::github_sign_out,
            github::github_device_available,
            github::github_device_start,
            github::github_device_poll,
            github::github_repositories,
            github::github_repository,
            github::github_pull_requests,
            github::github_create_pull_request,
            github::github_issues,
            github::github_create_issue,
            github::github_issue_comments,
            github::github_comment_issue,
            github::github_close_issue,
            github::github_workflow_runs,
            github::github_workflow_jobs,
            // commit message assistant
            ai::ai_providers,
            ai::ai_save_key,
            ai::ai_clear_key,
            ai::ai_models,
            ai::ai_commit_message,
            // updates of the application
            update::update_check,
            update::update_install,
        ])
        .events(collect_events![
            watcher::RepositoryChanged,
            progress::OperationProgress,
            update::UpdateProgress
        ])
        // Timestamps are `i64` seconds; they fit in a JavaScript number.
        .dangerously_cast_bigints_to_number()
}

/// Writes the TypeScript bindings the frontend imports.
///
/// Runs on every debug start, so the file stays in sync with the commands.
/// (A `#[test]` would be nicer, but on Windows the test harness of this crate
/// fails to load with `STATUS_ENTRYPOINT_NOT_FOUND`.)
#[cfg(debug_assertions)]
fn export_bindings(builder: &Builder<tauri::Wry>) {
    builder
        .export(
            Typescript::default().header("// @ts-nocheck\n"),
            "../src/bindings.ts",
        )
        .expect("failed to export typescript bindings");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Started by `git` for credentials: answer and leave, no window.
    if let Some(prompt) = askpass::request() {
        askpass::run(&prompt);
    }
    askpass::install();

    let builder = specta_builder();

    #[cfg(debug_assertions)]
    export_bindings(&builder);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::default())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
