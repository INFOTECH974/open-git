use http::StatusCode;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("GitHub refused the request: {}", describe(.0))]
    Api(#[from] octocrab::Error),
    #[error("could not reach GitHub: {0}")]
    Http(#[from] reqwest::Error),
    #[error("the system keychain refused the request: {0}")]
    Keychain(#[from] keyring::Error),
    #[error("`{url}` is not a GitHub repository")]
    NotGitHub { url: String },
    #[error("no GitHub account is connected")]
    SignedOut,
    #[error("`{login}` is not a connected GitHub account")]
    UnknownAccount { login: String },
    #[error("GitHub sign-in is not configured for this build (no OAuth client id)")]
    NoClientId,
    #[error("GitHub sign-in failed: {0}")]
    Device(String),
}

impl Error {
    /// The HTTP status GitHub answered with, when it answered.
    pub fn status(&self) -> Option<StatusCode> {
        match self {
            Self::Api(octocrab::Error::GitHub { source, .. }) => Some(source.status_code),
            _ => None,
        }
    }

    /// Whether GitHub no longer accepts the token: revoked, expired or mistyped.
    pub fn is_unauthorized(&self) -> bool {
        self.status() == Some(StatusCode::UNAUTHORIZED)
    }
}

/// What went wrong, in words: octocrab names some of its errors only by their
/// kind (`GitHub`), leaving the reason in their source.
fn describe(error: &octocrab::Error) -> String {
    match error {
        octocrab::Error::GitHub { source, .. } => {
            format!("{} ({})", source.message, source.status_code)
        }
        other => match std::error::Error::source(other) {
            Some(source) => source.to_string(),
            None => other.to_string(),
        },
    }
}

pub type Result<T> = std::result::Result<T, Error>;
