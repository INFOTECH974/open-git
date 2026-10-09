//! The `GIT_ASKPASS` mode of the executable.
//!
//! The application registers itself as the askpass program of every `git` it
//! runs (see `gitui_core::set_askpass`). When `git` needs HTTPS credentials that
//! no credential helper provides, it starts this same executable with the prompt
//! as its only argument and `GITUI_ASKPASS` in the environment, and reads the
//! answer on stdout. The GitHub token comes from the system keychain, so it is
//! never passed through the environment or the command line.

use std::io::Write;

/// The prompt, when this process was started by `git` as its askpass helper.
pub fn request() -> Option<String> {
    std::env::var_os(gitui_core::ASKPASS_ENV)?;
    let mut args = std::env::args().skip(1);
    let prompt = args.next()?;
    if args.next().is_some() {
        return None;
    }
    Some(prompt)
}

/// Prints the answer to `prompt` and exits. Without an answer the process fails,
/// and `git` reports the missing credentials as it would without a helper.
pub fn run(prompt: &str) -> ! {
    let answer = gitui_forge::answer_prompt(prompt, || gitui_forge::load_token().ok().flatten());
    match answer {
        Some(line) => {
            let mut stdout = std::io::stdout().lock();
            let written = writeln!(stdout, "{line}").and_then(|()| stdout.flush());
            std::process::exit(if written.is_ok() { 0 } else { 1 })
        }
        None => std::process::exit(1),
    }
}

/// Registers this executable as the askpass program of `git`.
pub fn install() {
    match std::env::current_exe() {
        Ok(program) => gitui_core::set_askpass(program),
        Err(error) => eprintln!("gitui: cannot register the askpass helper: {error}"),
    }
}
