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

/// What `git` prints on stderr, as a terminal leaves it on screen.
///
/// Progress lines end with `\r` so that a terminal overwrites them in place.
/// Each is reported, but only the lines that stay are kept: a failure would
/// otherwise bury its reason under hundreds of percentages.
#[derive(Default)]
struct TerminalLines {
    text: String,
    partial: Vec<u8>,
    /// The last line ended by `\r`, until the next one overwrites it.
    overwritten: Option<String>,
}

impl TerminalLines {
    fn feed(&mut self, bytes: &[u8], on_progress: &mut dyn FnMut(&str)) {
        for &byte in bytes {
            match byte {
                b'\r' if !self.partial.is_empty() => {
                    let line = lossy(&self.partial);
                    on_progress(line.trim());
                    self.overwritten = Some(line);
                    self.partial.clear();
                }
                b'\r' => {}
                b'\n' => {
                    if !self.partial.is_empty() {
                        let line = lossy(&self.partial);
                        on_progress(line.trim());
                        self.keep(&line);
                        self.partial.clear();
                    } else if let Some(line) = self.overwritten.take() {
                        // `\r\n`: a line of its own after all.
                        self.keep(&line);
                    }
                    self.overwritten = None;
                }
                _ => {
                    self.overwritten = None;
                    self.partial.push(byte);
                }
            }
        }
    }

    /// The kept lines, the last one included even without its line break.
    fn finish(mut self, on_progress: &mut dyn FnMut(&str)) -> String {
        if !self.partial.is_empty() {
            let line = lossy(&self.partial);
            on_progress(line.trim());
            self.keep(&line);
        } else if let Some(line) = self.overwritten.take() {
            self.keep(&line);
        }
        self.text
    }

    fn keep(&mut self, line: &str) {
        self.text.push_str(line);
        self.text.push('\n');
    }
}

/// `Counting objects: 100% (137/137), done.`, `remote: Enumerating objects: 5,
/// done.` and the like, in any language: how far a transfer went, not why it
/// failed.
fn is_progress(line: &str) -> bool {
    let line = line.trim_start();
    let line = line.strip_prefix("remote:").unwrap_or(line);
    let Some((_, rest)) = line.split_once(": ") else {
        return false;
    };
    let rest = rest.trim_start();
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    digits > 0 && matches!(rest[digits..].chars().next(), None | Some('%' | ','))
}

fn failure(args: &[&str], code: Option<i32>, stdout: &str, stderr: &str) -> Error {
    let stderr = stderr
        .lines()
        .filter(|line| !is_progress(line))
        .collect::<Vec<_>>()
        .join("\n");
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

    let mut lines = TerminalLines::default();
    let mut buffer = [0u8; 4096];
    loop {
        let read = match stderr.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        lines.feed(&buffer[..read], on_progress);
    }
    let stderr_text = lines.finish(on_progress);

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

    #[test]
    fn a_failure_keeps_what_a_terminal_would_show_but_the_progress() {
        let stderr = "Enumerating objects: 137, done.\n\
            Counting objects:   0% (1/137)\rCounting objects:  50% (69/137)\r\
            Counting objects: 100% (137/137), done.\n\
            Writing objects: 100% (80/80), 1.20 MiB | 2.00 MiB/s, done.\n\
            remote: Resolving deltas: 100% (40/40)\r\n\
            Total 80 (delta 40), reused 0 (delta 0)\n\
            remote: Permission to octo/cat.git denied to ada.\r\n\
            fatal: unable to access 'https://github.com/octo/cat.git/': The requested URL returned error: 403";
        let mut reported = Vec::new();
        let mut lines = TerminalLines::default();
        // In two pieces, cut in the middle of a line, as a pipe may deliver it.
        let (first, second) = stderr.split_at(120);
        let mut report = |line: &str| reported.push(line.to_owned());
        lines.feed(first.as_bytes(), &mut report);
        lines.feed(second.as_bytes(), &mut report);
        let kept = lines.finish(&mut report);

        assert!(reported.contains(&"Counting objects:  50% (69/137)".to_owned()));
        assert!(!kept.contains("50%"), "{kept}");
        assert!(
            kept.contains("remote: Resolving deltas: 100% (40/40)\n"),
            "{kept}"
        );

        let Error::Command { message, .. } = failure(&["push"], Some(128), "", &kept) else {
            panic!("a failed command");
        };
        assert_eq!(
            message,
            "Total 80 (delta 40), reused 0 (delta 0)\n\
             remote: Permission to octo/cat.git denied to ada.\n\
             fatal: unable to access 'https://github.com/octo/cat.git/': The requested URL returned error: 403"
        );
    }

    #[test]
    fn progress_is_told_apart_in_any_language() {
        assert!(is_progress("Counting objects: 100% (3/3), done."));
        assert!(is_progress("Énumération des objets: 3, fait."));
        assert!(is_progress("remote: Compressing objects:  50% (1/2)"));
        assert!(is_progress("Receiving objects: 7"));
        assert!(!is_progress(
            "fatal: unable to access 'https://x/': error: 403"
        ));
        assert!(!is_progress("error: failed to push some refs to 'origin'"));
        assert!(!is_progress(
            " ! [rejected]        main -> main (fetch first)"
        ));
        assert!(!is_progress(
            "hint: Updates were rejected because the remote contains work"
        ));
    }
}
