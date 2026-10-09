//! Answers the credential prompts of `git` for GitHub with the stored token.
//!
//! When a fetch, pull, push or clone over HTTPS needs credentials that no
//! credential helper provides, `git` runs `$GIT_ASKPASS "<prompt>"` twice (once
//! for the user name, once for the password) and reads one line on stdout each
//! time. The application sets itself as that program; this module decides what
//! it prints.

/// What `git` is asking for, and for which host.
#[derive(Debug, PartialEq, Eq)]
pub enum Prompt<'a> {
    Username { host: &'a str },
    Password { host: &'a str },
}

impl Prompt<'_> {
    pub fn host(&self) -> &str {
        match self {
            Prompt::Username { host } | Prompt::Password { host } => host,
        }
    }
}

/// Parses prompts such as `Username for 'https://github.com': ` and
/// `Password for 'https://me@github.com': `.
pub fn parse_prompt(prompt: &str) -> Option<Prompt<'_>> {
    let (field, rest) = prompt.trim_start().split_once(" for '")?;
    let url = rest.split('\'').next()?;
    let after_scheme = url.split_once("://").map_or(url, |(_, rest)| rest);
    let authority = after_scheme.split('/').next()?;
    let host = authority.rsplit('@').next()?.split(':').next()?;
    if host.is_empty() {
        return None;
    }
    match field {
        "Username" => Some(Prompt::Username { host }),
        "Password" => Some(Prompt::Password { host }),
        _ => None,
    }
}

fn is_github(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    host == "github.com" || host.ends_with(".github.com")
}

/// The line to print for `prompt`, when the GitHub token `token` returns applies.
///
/// `None` means the prompt is not for GitHub or no account is connected: the
/// program then exits with a failure and `git` reports the missing credentials
/// as it would without a helper.
pub fn answer_prompt(prompt: &str, token: impl FnOnce() -> Option<String>) -> Option<String> {
    let prompt = parse_prompt(prompt)?;
    if !is_github(prompt.host()) {
        return None;
    }
    let token = token()?;
    match prompt {
        // GitHub ignores the user name when the password is a token.
        Prompt::Username { .. } => Some("x-access-token".to_owned()),
        Prompt::Password { .. } => Some(token),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_username_and_password_prompts() {
        assert_eq!(
            parse_prompt("Username for 'https://github.com': "),
            Some(Prompt::Username { host: "github.com" })
        );
        assert_eq!(
            parse_prompt("Password for 'https://me@github.com': "),
            Some(Prompt::Password { host: "github.com" })
        );
        assert_eq!(
            parse_prompt("Password for 'https://me@git.example.org:8443/team/repo.git': "),
            Some(Prompt::Password {
                host: "git.example.org"
            })
        );
    }

    #[test]
    fn rejects_other_prompts() {
        assert_eq!(
            parse_prompt("Enter passphrase for key '/home/me/.ssh/id_ed25519': "),
            None
        );
        assert_eq!(parse_prompt("Username for '': "), None);
        assert_eq!(parse_prompt(""), None);
    }

    #[test]
    fn answers_only_github_with_a_token() {
        let token = || Some("ghp_secret".to_owned());
        assert_eq!(
            answer_prompt("Username for 'https://github.com': ", token).as_deref(),
            Some("x-access-token")
        );
        assert_eq!(
            answer_prompt("Password for 'https://me@GitHub.com': ", token).as_deref(),
            Some("ghp_secret")
        );
        assert_eq!(
            answer_prompt("Password for 'https://me@api.github.com': ", token).as_deref(),
            Some("ghp_secret")
        );
        assert_eq!(
            answer_prompt("Password for 'https://gitlab.com': ", token),
            None
        );
        assert_eq!(
            answer_prompt("Password for 'https://notgithub.com': ", token),
            None
        );
        assert_eq!(
            answer_prompt("Username for 'https://github.com': ", || None),
            None
        );
    }
}
