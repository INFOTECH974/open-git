//! The assistants already installed on the machine, Claude Code (`claude`) and
//! Codex (`codex`), run once without a terminal. Like `git`, they are the
//! user's own programs: they answer with the account they are signed in to, so
//! there is no key to give.
//!
//! Both are agents that can use tools. Here they only write text: `claude`
//! runs without any tool, `codex` in its read-only sandbox, and both in an
//! empty directory rather than in the repository.

use std::{
    env,
    ffi::OsString,
    path::{Path, PathBuf},
    pin::pin,
    process::Stdio,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use serde_json::Value;
use tokio::{io::AsyncWriteExt, process::Command};

use crate::{AiModel, Error, Provider, Result};

/// Both programs start slower than an API call and may think for a while.
const TIMEOUT: Duration = Duration::from_secs(180);

/// Replaces the coding-agent prompt of Claude Code. One plain line, because an
/// installation through npm starts `claude` from a batch file, which cannot
/// carry line breaks in an argument; the real instructions go through stdin.
const CLAUDE_SYSTEM: &str = "You write Git commit messages. Follow the instructions at the top of the message and answer with the commit message alone.";

/// What `claude --model` accepts for "the latest of this family".
const CLAUDE_MODELS: [&str; 4] = ["opus", "sonnet", "haiku", "fable"];

/// Without this, the program flashes a console window in release builds.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Whether the program of `provider` is installed where it can be found.
pub fn cli_available(provider: Provider) -> bool {
    provider.program().and_then(find_program).is_some()
}

/// The models to offer for a command-line assistant, besides its own default.
/// Codex takes its model from its configuration; there is nothing to list.
pub fn cli_models(provider: Provider) -> Vec<AiModel> {
    let ids: &[&str] = match provider {
        Provider::ClaudeCode => &CLAUDE_MODELS,
        _ => &[],
    };
    ids.iter()
        .map(|id| AiModel {
            id: (*id).to_owned(),
            name: (*id).to_owned(),
        })
        .collect()
}

/// Asks the program of `provider` to answer `user` under the instructions of
/// `system`. An empty `model` leaves the choice to the program.
pub(crate) async fn complete(
    provider: Provider,
    model: &str,
    system: &str,
    user: &str,
) -> Result<String> {
    let name = provider
        .program()
        .ok_or(Error::NotACommand(provider.label()))?;
    let program = find_program(name).ok_or(Error::CliNotFound(name))?;
    let workdir = env::temp_dir().join("open-git-assistant");
    std::fs::create_dir_all(&workdir)?;
    let input = format!("{system}\n\n{user}");

    match provider {
        Provider::Codex => {
            let answer_file = workdir.join(answer_file_name());
            let args = codex_args(model, &workdir, &answer_file);
            let output = run(name, &program, &args, &[], &workdir, input).await;
            let written = std::fs::read_to_string(&answer_file).unwrap_or_default();
            let _ = std::fs::remove_file(&answer_file);
            let output = output?;
            codex_answer(&written, &output)
        }
        _ => {
            // A refused sign-in is otherwise retried for minutes before failing.
            let envs = [("CLAUDE_CODE_MAX_RETRIES", "2")];
            let args: Vec<OsString> = claude_args(model).into_iter().map(Into::into).collect();
            let output = run(name, &program, &args, &envs, &workdir, input).await?;
            claude_answer(&output)
        }
    }
}

fn claude_args(model: &str) -> Vec<&str> {
    let mut args = vec![
        "-p",
        "--output-format",
        "json",
        // No tool at all: the diff is text to read, never something to act on.
        "--tools",
        "",
        // Nothing of the user's setup is needed to write a message, and
        // starting MCP servers or hooks would only slow the answer down.
        "--strict-mcp-config",
        "--safe-mode",
        "--no-session-persistence",
        "--effort",
        "low",
        "--system-prompt",
        CLAUDE_SYSTEM,
    ];
    if !model.is_empty() {
        args.extend(["--model", model]);
    }
    args
}

fn codex_args(model: &str, workdir: &Path, answer_file: &Path) -> Vec<OsString> {
    let mut args: Vec<OsString> = [
        "exec",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--ephemeral",
        "--color",
        "never",
    ]
    .into_iter()
    .map(Into::into)
    .collect();
    args.extend(["-C".into(), workdir.into(), "-o".into(), answer_file.into()]);
    if !model.is_empty() {
        args.extend(["-m".into(), model.into()]);
    }
    // The prompt comes from stdin: a diff does not fit on a command line.
    args.push("-".into());
    args
}

fn answer_file_name() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    format!("answer-{}-{id}.txt", std::process::id())
}

/// What a finished program printed, and whether it reported success.
struct Output {
    name: &'static str,
    success: bool,
    stdout: String,
    stderr: String,
}

async fn run(
    name: &'static str,
    program: &Path,
    args: &[OsString],
    envs: &[(&str, &str)],
    workdir: &Path,
    input: String,
) -> Result<Output> {
    let mut command = Command::new(program);
    command
        .args(args)
        .envs(envs.iter().copied())
        .current_dir(workdir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command.spawn()?;
    let id = child.id();
    let mut stdin = child.stdin.take().expect("stdin was piped");
    // Written beside the reading, or a program that prints before it has read
    // everything would wait on a full pipe, and so would this.
    let writer = tokio::spawn(async move {
        let _ = stdin.write_all(input.as_bytes()).await;
        let _ = stdin.shutdown().await;
    });

    let mut finished = pin!(child.wait_with_output());
    let output = match tokio::time::timeout(TIMEOUT, &mut finished).await {
        Ok(output) => output?,
        Err(_) => {
            // While the process still exists, so that its children are found.
            kill_tree(id);
            return Err(Error::TimedOut(name));
        }
    };
    let _ = writer.await;
    Ok(Output {
        name,
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// Stops the program together with what it started: behind a batch file, the
/// real program is a child that `kill_on_drop` alone would leave running.
fn kill_tree(id: Option<u32>) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if let Some(id) = id {
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &id.to_string(), "/T", "/F"])
                .creation_flags(CREATE_NO_WINDOW)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
    #[cfg(not(windows))]
    let _ = id;
}

/// `claude --output-format json` prints one object: the answer in `result`, or
/// the reason of a failure there with `is_error` set.
fn claude_answer(output: &Output) -> Result<String> {
    if let Ok(result) = serde_json::from_str::<Value>(output.stdout.trim()) {
        let text = result["result"].as_str().unwrap_or_default().trim();
        if result["is_error"] == true {
            return Err(failure(output, (!text.is_empty()).then(|| text.to_owned())));
        }
        if !text.is_empty() {
            return Ok(text.to_owned());
        }
    }
    Err(failure(output, None))
}

/// `codex exec -o` writes its last message to a file; everything else it
/// prints is a log, with the reason of a failure on an `ERROR:` line.
fn codex_answer(written: &str, output: &Output) -> Result<String> {
    if !written.trim().is_empty() {
        return Ok(written.trim().to_owned());
    }
    let reason = output
        .stderr
        .lines()
        .rev()
        .find_map(|line| line.strip_prefix("ERROR:"))
        .map(|reason| {
            let reason = reason.trim();
            serde_json::from_str::<Value>(reason)
                .ok()
                .and_then(|json| json["error"]["message"].as_str().map(str::to_owned))
                .unwrap_or_else(|| reason.to_owned())
        });
    Err(failure(output, reason))
}

/// Why the program failed: `reason` when it gave one, otherwise the last thing
/// it printed.
fn failure(output: &Output, reason: Option<String>) -> Error {
    let last_line = |text: &str| {
        text.lines()
            .rev()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(str::to_owned)
    };
    let message = reason
        .or_else(|| last_line(&output.stderr))
        .or_else(|| last_line(&output.stdout))
        .unwrap_or_else(|| {
            if output.success {
                "it answered nothing".to_owned()
            } else {
                "it stopped without an explanation".to_owned()
            }
        });
    Error::Cli {
        program: output.name,
        message: message.chars().take(400).collect(),
    }
}

/// Finds `name` on the `PATH`, then where these programs usually install: a
/// desktop application does not always inherit the `PATH` of a terminal.
fn find_program(name: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH").unwrap_or_default();
    env::split_paths(&path)
        .chain(usual_directories())
        .find_map(|directory| program_in(&directory, name))
}

fn program_in(directory: &Path, name: &str) -> Option<PathBuf> {
    // On Windows an npm installation is a batch file next to the script.
    let extensions: &[&str] = if cfg!(windows) {
        &["exe", "cmd", "bat"]
    } else {
        &[""]
    };
    extensions
        .iter()
        .map(|extension| directory.join(name).with_extension(extension))
        .find(|candidate| candidate.is_file())
}

fn usual_directories() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    if let Some(home) = env::var_os("USERPROFILE").or_else(|| env::var_os("HOME")) {
        let home = PathBuf::from(home);
        for relative in [".local/bin", ".claude/local", ".npm-global/bin", ".bun/bin"] {
            directories.push(home.join(relative));
        }
    }
    if cfg!(windows) {
        if let Some(roaming) = env::var_os("APPDATA") {
            directories.push(PathBuf::from(roaming).join("npm"));
        }
    } else {
        directories.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    }
    directories
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output(success: bool, stdout: &str, stderr: &str) -> Output {
        Output {
            name: "program",
            success,
            stdout: stdout.to_owned(),
            stderr: stderr.to_owned(),
        }
    }

    fn message(error: Error) -> String {
        match error {
            Error::Cli { message, .. } => message,
            other => panic!("expected a program failure, got {other:?}"),
        }
    }

    #[test]
    fn claude_runs_without_tools_and_with_the_chosen_model() {
        let default = claude_args("");
        let tools = default.iter().position(|arg| *arg == "--tools").unwrap();
        assert_eq!(default[tools + 1], "");
        assert!(!default.contains(&"--model"));
        assert!(!CLAUDE_SYSTEM.contains('\n'));

        let chosen = claude_args("sonnet");
        assert_eq!(chosen[chosen.len() - 2..], ["--model", "sonnet"]);
    }

    #[test]
    fn codex_reads_the_prompt_from_stdin_in_a_read_only_sandbox() {
        let args = codex_args("", Path::new("work"), Path::new("work/answer.txt"));
        assert_eq!(args[0], "exec");
        assert!(
            args.windows(2)
                .any(|pair| pair[0] == "--sandbox" && pair[1] == "read-only")
        );
        assert!(
            args.windows(2)
                .any(|pair| pair[0] == "-o" && pair[1] == "work/answer.txt")
        );
        assert!(!args.iter().any(|arg| arg == "-m"));
        assert_eq!(args.last().unwrap(), "-");

        let chosen = codex_args("some-model", Path::new("work"), Path::new("a.txt"));
        assert!(
            chosen
                .windows(2)
                .any(|pair| pair[0] == "-m" && pair[1] == "some-model")
        );
        assert_eq!(chosen.last().unwrap(), "-");
    }

    #[test]
    fn claude_answers_are_read_from_the_result_object() {
        let answered = output(
            true,
            r#"{"type":"result","is_error":false,"result":"Fix the parser\n"}"#,
            "",
        );
        assert_eq!(claude_answer(&answered).unwrap(), "Fix the parser");

        let refused = output(
            false,
            r#"{"type":"result","is_error":true,"result":"Failed to authenticate. API Error: 401 Invalid API key"}"#,
            "",
        );
        assert_eq!(
            message(claude_answer(&refused).unwrap_err()),
            "Failed to authenticate. API Error: 401 Invalid API key"
        );

        let crashed = output(false, "", "error: unknown option '--safe-mode'\n");
        assert_eq!(
            message(claude_answer(&crashed).unwrap_err()),
            "error: unknown option '--safe-mode'"
        );
    }

    #[test]
    fn codex_answers_come_from_the_file_and_failures_from_the_log() {
        let quiet = output(true, "", "OpenAI Codex\n");
        assert_eq!(
            codex_answer("Fix the parser\n", &quiet).unwrap(),
            "Fix the parser"
        );

        let refused = output(
            false,
            "",
            "hook: SessionStart\nERROR: {\"type\":\"error\",\"status\":400,\"error\":{\"message\":\"The model is not supported.\"}}\n",
        );
        assert_eq!(
            message(codex_answer("", &refused).unwrap_err()),
            "The model is not supported."
        );

        let plain = output(false, "", "ERROR: not signed in\n");
        assert_eq!(
            message(codex_answer("", &plain).unwrap_err()),
            "not signed in"
        );
        let silent = output(true, "", "");
        assert_eq!(
            message(codex_answer("", &silent).unwrap_err()),
            "it answered nothing"
        );
    }

    #[test]
    fn only_the_command_line_assistants_have_models_of_their_own() {
        let claude: Vec<String> = cli_models(Provider::ClaudeCode)
            .into_iter()
            .map(|model| model.id)
            .collect();
        assert_eq!(claude, CLAUDE_MODELS);
        assert!(cli_models(Provider::Codex).is_empty());
        assert!(!cli_available(Provider::Anthropic));
    }

    #[test]
    fn a_program_is_found_by_its_name_in_a_directory() {
        let directory = env::temp_dir().join(format!("open-git-find-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let file = if cfg!(windows) { "tool.cmd" } else { "tool" };
        std::fs::write(directory.join(file), "").unwrap();

        assert_eq!(program_in(&directory, "tool"), Some(directory.join(file)));
        assert_eq!(program_in(&directory, "missing"), None);
        std::fs::remove_dir_all(&directory).unwrap();
    }
}
