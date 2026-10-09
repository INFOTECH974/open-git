#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("GitHub refused the request: {0}")]
    Api(#[from] octocrab::Error),
    #[error("could not reach GitHub: {0}")]
    Http(#[from] reqwest::Error),
    #[error("the system keychain refused the request: {0}")]
    Keychain(#[from] keyring::Error),
    #[error("`{url}` is not a GitHub repository")]
    NotGitHub { url: String },
    #[error("no GitHub account is connected")]
    SignedOut,
    #[error("GitHub sign-in is not configured for this build (no OAuth client id)")]
    NoClientId,
    #[error("GitHub sign-in failed: {0}")]
    Device(String),
}

pub type Result<T> = std::result::Result<T, Error>;
