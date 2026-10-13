//! Runs the user's `git` binary for everything that writes or talks to the network,
//! so hooks, commit signing, credential helpers, SSH configuration and LFS behave
//! exactly as they do on the command line.

use std::{
    ffi::OsString,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::Duration,
};

use crate::{Error, Result, lossy};

/// The environment variable that tells [`ASKPASS`] why it was started.
pub const ASKPASS_ENV: &str = "OPEN_GIT_ASKPASS";

static ASKPASS: OnceLock<PathBuf> = OnceLock::new();

/// Makes every `git` call ask `program` for HTTPS credentials that no credential
/// helper provides (`GIT_ASKPASS`), with [`ASKPASS_ENV`] set in its environment
/// so the program knows it runs as a helper. The first call wins.
pub fn set_askpass(program: PathBuf) {
    let _ = ASKPASS.set(program);
}

/// Gives the `git` started with `env` one more configuration value, as
/// `git -c key=value` would.
///
/// It goes through `GIT_CONFIG_COUNT`, which git reads since 2.31; an older one
/// ignores it.
pub fn add_config(env: &mut Vec<(OsString, OsString)>, key: &str, value: &str) {
    const COUNT: &str = "GIT_CONFIG_COUNT";
    let position = env.iter().position(|(name, _)| name == COUNT);
    let count = match position {
        Some(position) => env[position]
            .1
            .to_str()
            .and_then(|count| count.parse().ok()),
        // What the application itself was started with still applies.
        None => std::env::var(COUNT)
            .ok()
            .and_then(|count| count.parse().ok()),
    }
    .unwrap_or(0usize);
    env.push((format!("GIT_CONFIG_KEY_{count}").into(), key.into()));
    env.push((format!("GIT_CONFIG_VALUE_{count}").into(), value.into()));
    let total = (COUNT.into(), (count + 1).to_string().into());
    match position {
        Some(position) => env[position] = total,
        None => env.push(total),
    }
}

pub(crate) struct GitOutput {
    #[allow(dead_code)]
    pub stdout: String,
    #[allow(dead_code)]
    pub stderr: String,
}

/// Lets another thread stop a running `git` process.
///
/// Cloned tokens share the same process: cancelling any of them kills it.
#[derive(Clone, Default)]
pub struct CancelToken {
    inner: Arc<Mutex<TokenState>>,
}

#[derive(Default)]
struct TokenState {
    child: Option<Child>,
    cancelled: bool,
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    /// Kills the process if it is running, and makes a later start fail at once.
    pub fn cancel(&self) {
        let mut state = self.lock();
        state.cancelled = true;
        if let Some(child) = state.child.as_mut() {
            kill_tree(child);
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.lock().cancelled
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, TokenState> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Without this, every process started here flashes a console window in release builds.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Kills `child` together with the processes it started.
///
/// `git` leaves the network to helpers (`git-remote-https`, `ssh`, and on Windows
/// the real `git.exe` behind the launcher found on the `PATH`). Killing `child`
/// alone would let them finish the transfer, holding the pipes read on this side.
fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(unix)]
    {
        // The child leads the process group `git_with_progress` gave it.
        if let Ok(group) = libc::pid_t::try_from(child.id()) {
            // SAFETY: `killpg` only sends a signal and touches no memory. The child
            // is not reaped yet (its token still holds it), so the id is its own.
            unsafe {
                libc::killpg(group, libc::SIGKILL);
            }
        }
    }
    let _ = child.kill();
}

fn command(workdir: &Path, env: &[(OsString, OsString)], args: &[&str]) -> Command {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(workdir)
        // A desktop application has no terminal: fail instead of waiting for input.
        // Graphical credential helpers still work.
        .env("GIT_TERMINAL_PROMPT", "0")
        // Never open an editor (merge and revert messages, rebase todo lists):
        // `:` is the shell no-op, so the default message is kept as is.
        .env("GIT_EDITOR", ":")
        .env("GIT_SEQUENCE_EDITOR", ":")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(program) = ASKPASS.get() {
        command.env("GIT_ASKPASS", program).env(ASKPASS_ENV, "1");
    }
    for (key, value) in env {
        command.env(key, value);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn failure(args: &[&str], code: Option<i32>, stdout: &str, stderr: &str) -> Error {
    let message = if stderr.trim().is_empty() {
        stdout.trim().to_owned()
    } else {
        stderr.trim().to_owned()
    };
    Error::Command {
        command: format!("git {}", args.join(" ")),
        code,
        message,
    }
}

/// Runs `git <args>` in `workdir`, feeding `stdin` to the process when given.
///
/// `env` is added to the inherited environment; tests use it to isolate `git`
/// from the user's configuration.
pub(crate) fn git(
    workdir: &Path,
    env: &[(OsString, OsString)],
    args: &[&str],
    stdin: Option<&str>,
) -> Result<GitOutput> {
    let mut command = command(workdir, env, args);
    command.stdin(if stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });

    let mut child = command.spawn().map_err(|source| Error::Spawn { source })?;
    if let Some(input) = stdin {
        let mut pipe = child.stdin.take().expect("stdin was piped");
        pipe.write_all(input.as_bytes())
            .map_err(|source| Error::Spawn { source })?;
        drop(pipe);
    }
    let output = child
        .wait_with_output()
        .map_err(|source| Error::Spawn { source })?;

    let stdout = lossy(&output.stdout);
    let stderr = lossy(&output.stderr);
    if !output.status.success() {
        return Err(failure(args, output.status.code(), &stdout, &stderr));
    }
    Ok(GitOutput { stdout, stderr })
}

/// Like [`git`], but reports every line `git` prints on stderr as it arrives
/// (its `--progress` output, mostly) and can be stopped through `token`.
pub(crate) fn git_with_progress(
    workdir: &Path,
    env: &[(OsString, OsString)],
    args: &[&str],
    token: &CancelToken,
    on_progress: &mut dyn FnMut(&str),
) -> Result<GitOutput> {
    if token.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let mut command = command(workdir, env, args);
    command.stdin(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own group, so that cancelling reaches the helpers it starts too.
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|source| Error::Spawn { source })?;
    let stdout = child.stdout.take().expect("stdout was piped");
    let mut stderr = child.stderr.take().expect("stderr was piped");
    {
        let mut state = token.lock();
        if state.cancelled {
            kill_tree(&mut child);
        }
        state.child = Some(child);
    }

    let stdout_reader = thread::spawn(move || {
        let mut stdout = stdout;
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        lossy(&bytes)
    });

    // Progress lines end with `\r` so that a terminal overwrites them in place.
    let mut stderr_text = String::new();
    let mut partial = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        let read = match stderr.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        for &byte in &buffer[..read] {
            if byte == b'\r' || byte == b'\n' {
                if !partial.is_empty() {
                    let line = lossy(&partial);
                    on_progress(line.trim());
                    stderr_text.push_str(&line);
                    stderr_text.push('\n');
                    partial.clear();
                }
            } else {
                partial.push(byte);
            }
        }
    }
    if !partial.is_empty() {
        let line = lossy(&partial);
        on_progress(line.trim());
        stderr_text.push_str(&line);
    }

    // Polling keeps the token free for `cancel` while the process finishes.
    let status = loop {
        let waited = {
            let mut state = token.lock();
            let child = state.child.as_mut().expect("the child was stored");
            let waited = child.try_wait().map_err(|source| Error::Spawn { source })?;
            if waited.is_some() {
                // Reaped: its id may be reused, so `cancel` must not see it again.
                state.child = None;
            }
            waited
        };
        match waited {
            Some(status) => break status,
            None => thread::sleep(Duration::from_millis(50)),
        }
    };
    let stdout_text = stdout_reader.join().unwrap_or_default();

    if token.is_cancelled() {
        return Err(Error::Cancelled);
    }
    if !status.success() {
        return Err(failure(args, status.code(), &stdout_text, &stderr_text));
    }
    Ok(GitOutput {
        stdout: stdout_text,
        stderr: stderr_text,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn added_configuration_reaches_git() {
        let mut env = Vec::new();
        add_config(&mut env, "open-git-test.first", "one");
        add_config(&mut env, "open-git-test.second", "two words");

        let read = |key: &str| {
            let output = git(&std::env::temp_dir(), &env, &["config", "--get", key], None);
            output.map(|output| output.stdout.trim().to_owned()).ok()
        };
        assert_eq!(read("open-git-test.first").as_deref(), Some("one"));
        assert_eq!(read("open-git-test.second").as_deref(), Some("two words"));
        assert_eq!(read("open-git-test.third"), None);
    }
}
