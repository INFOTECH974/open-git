//! Answers the credential prompts of `git` for GitHub with a stored token.
//!
//! When a fetch, pull, push or clone over HTTPS needs credentials that no
//! credential helper provides, `git` runs `$GIT_ASKPASS "<prompt>"` (once for the
//! user name unless it knows it, once for the password) and reads one line on
//! stdout each time. The application sets itself as that program; this module
//! decides what it prints.
//!
//! With several accounts connected, the application tells the `git` it starts
//! which one the repository uses, in two ways: [`ACCOUNT_ENV`], which reaches the
//! helper started by that `git`, and [`USERNAME_CONFIG`], which makes `git` ask
//! everyone (credential helpers first, then this helper) for that user name.

/// The environment variable naming the login of the account to answer for.
pub const ACCOUNT_ENV: &str = "OPEN_GIT_ACCOUNT";

/// The configuration variable that gives `git` the user name to ask github.com
/// credentials for. A credential helper then answers with what it holds for that
/// account only, and files under it what worked.
pub const USERNAME_CONFIG: &str = "credential.https://github.com.username";

/// An account `git` can be answered for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Credential {
    /// `None` for the token a version that knew a single account stored: whose
    /// it is was not written down.
    pub login: Option<String>,
    pub token: String,
}

/// What `git` is asking for, and for which host.
#[derive(Debug, PartialEq, Eq)]
pub enum Prompt<'a> {
    Username {
        host: &'a str,
    },
    Password {
        host: &'a str,
        /// The user name `git` already has, as `me` in `https://me@github.com`.
        user: Option<&'a str>,
    },
}

impl Prompt<'_> {
    pub fn host(&self) -> &str {
        match self {
            Prompt::Username { host } | Prompt::Password { host, .. } => host,
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
    let (user, address) = match authority.rsplit_once('@') {
        Some((user, address)) => (Some(user), address),
        None => (None, authority),
    };
    let host = address.split(':').next()?;
    if host.is_empty() {
        return None;
    }
    match field {
        "Username" => Some(Prompt::Username { host }),
        "Password" => Some(Prompt::Password {
            host,
            user: user.filter(|user| !user.is_empty()),
        }),
        _ => None,
    }
}

fn is_github(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    host == "github.com" || host.ends_with(".github.com")
}

/// The line to print for `prompt`, when a GitHub account applies.
///
/// `credentials` returns the connected accounts, the active one first, and
/// `wanted` is the login the application asked for ([`ACCOUNT_ENV`]). The token
/// is the one of the account `git` names in the prompt, else of the wanted one,
/// else of the active one.
///
/// `None` means the prompt is not for GitHub or no account is connected: the
/// program then exits with a failure and `git` reports the missing credentials
/// as it would without a helper.
pub fn answer_prompt(
    prompt: &str,
    wanted: Option<&str>,
    credentials: impl FnOnce() -> Vec<Credential>,
) -> Option<String> {
    let prompt = parse_prompt(prompt)?;
    if !is_github(prompt.host()) {
        return None;
    }
    let credentials = credentials();
    let named = |login: Option<&str>| {
        let login = login?;
        credentials.iter().find(|credential| {
            credential
                .login
                .as_deref()
                .is_some_and(|known| known.eq_ignore_ascii_case(login))
        })
    };
    match prompt {
        Prompt::Username { .. } => match named(wanted).and_then(|wanted| wanted.login.clone()) {
            // The password is then asked for that account, by name.
            Some(login) => Some(login),
            // GitHub ignores the user name when the password is a token.
            None => credentials.first().map(|_| "x-access-token".to_owned()),
        },
        Prompt::Password { user, .. } => named(user)
            .or_else(|| named(wanted))
            .or(credentials.first())
            .map(|credential| credential.token.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn credential(login: &str, token: &str) -> Credential {
        Credential {
            login: Some(login.to_owned()),
            token: token.to_owned(),
        }
    }

    /// Two accounts, `ada` being the active one.
    fn two() -> Vec<Credential> {
        vec![
            credential("ada", "ghp_ada"),
            credential("Grace", "ghp_grace"),
        ]
    }

    #[test]
    fn parses_username_and_password_prompts() {
        assert_eq!(
            parse_prompt("Username for 'https://github.com': "),
            Some(Prompt::Username { host: "github.com" })
        );
        assert_eq!(
            parse_prompt("Password for 'https://me@github.com': "),
            Some(Prompt::Password {
                host: "github.com",
                user: Some("me")
            })
        );
        assert_eq!(
            parse_prompt("Password for 'https://github.com': "),
            Some(Prompt::Password {
                host: "github.com",
                user: None
            })
        );
        assert_eq!(
            parse_prompt("Password for 'https://me@git.example.org:8443/team/repo.git': "),
            Some(Prompt::Password {
                host: "git.example.org",
                user: Some("me")
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
        let one = || vec![credential("ada", "ghp_secret")];
        assert_eq!(
            answer_prompt("Username for 'https://github.com': ", None, one).as_deref(),
            Some("x-access-token")
        );
        assert_eq!(
            answer_prompt("Password for 'https://me@GitHub.com': ", None, one).as_deref(),
            Some("ghp_secret")
        );
        assert_eq!(
            answer_prompt("Password for 'https://me@api.github.com': ", None, one).as_deref(),
            Some("ghp_secret")
        );
        assert_eq!(
            answer_prompt("Password for 'https://gitlab.com': ", None, one),
            None
        );
        assert_eq!(
            answer_prompt("Password for 'https://notgithub.com': ", None, one),
            None
        );
        assert_eq!(
            answer_prompt("Username for 'https://github.com': ", None, Vec::new),
            None
        );
        assert_eq!(
            answer_prompt("Password for 'https://github.com': ", Some("ada"), Vec::new),
            None
        );
    }

    #[test]
    fn the_keychain_is_left_alone_for_other_hosts() {
        let answer = answer_prompt("Password for 'https://gitlab.com': ", None, || {
            panic!("no token is needed for this host")
        });
        assert_eq!(answer, None);
    }

    #[test]
    fn the_account_git_names_answers_before_the_wanted_and_the_active_one() {
        let password = |prompt: &str, wanted: Option<&str>| answer_prompt(prompt, wanted, two);
        assert_eq!(
            password("Password for 'https://github.com': ", None).as_deref(),
            Some("ghp_ada")
        );
        assert_eq!(
            password("Password for 'https://github.com': ", Some("grace")).as_deref(),
            Some("ghp_grace")
        );
        assert_eq!(
            password("Password for 'https://GRACE@github.com': ", None).as_deref(),
            Some("ghp_grace")
        );
        assert_eq!(
            password("Password for 'https://ada@github.com': ", Some("grace")).as_deref(),
            Some("ghp_ada")
        );
        // A user name that is no connected account says nothing.
        assert_eq!(
            password(
                "Password for 'https://x-access-token@github.com': ",
                Some("grace")
            )
            .as_deref(),
            Some("ghp_grace")
        );
        assert_eq!(
            password("Password for 'https://git@github.com': ", Some("linus")).as_deref(),
            Some("ghp_ada")
        );
    }

    #[test]
    fn the_user_name_is_the_wanted_account_when_it_is_connected() {
        let username = |wanted: Option<&str>| {
            answer_prompt("Username for 'https://github.com': ", wanted, two)
        };
        assert_eq!(username(Some("grace")).as_deref(), Some("Grace"));
        assert_eq!(username(Some("linus")).as_deref(), Some("x-access-token"));
        assert_eq!(username(None).as_deref(), Some("x-access-token"));
    }

    #[test]
    fn the_token_of_a_single_account_version_has_no_name() {
        let legacy = || {
            vec![Credential {
                login: None,
                token: "ghp_old".to_owned(),
            }]
        };
        assert_eq!(
            answer_prompt("Username for 'https://github.com': ", Some("ada"), legacy).as_deref(),
            Some("x-access-token")
        );
        assert_eq!(
            answer_prompt("Password for 'https://ada@github.com': ", None, legacy).as_deref(),
            Some("ghp_old")
        );
    }
}
