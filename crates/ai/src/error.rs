#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("could not reach the model provider: {0}")]
    Http(#[from] reqwest::Error),
    #[error("{provider} refused the request ({status}): {message}")]
    Api {
        provider: &'static str,
        status: u16,
        message: String,
    },
    #[error("the system keychain refused the request: {0}")]
    Keychain(#[from] keyring::Error),
    #[error("no {0} API key is stored")]
    NoKey(&'static str),
    #[error("{0} does not use an API key")]
    Keyless(&'static str),
    #[error("{0} is not a program to run")]
    NotACommand(&'static str),
    #[error("`{0}` was not found on this computer")]
    CliNotFound(&'static str),
    #[error("could not run the assistant: {0}")]
    Io(#[from] std::io::Error),
    #[error("`{program}` failed: {message}")]
    Cli {
        program: &'static str,
        message: String,
    },
    #[error("`{0}` did not answer in time")]
    TimedOut(&'static str),
    #[error("there is no staged change to describe")]
    NothingStaged,
    #[error("{0} declined to write a message for these changes")]
    Refused(&'static str),
    #[error("{0} ran out of room before finishing its answer")]
    CutOff(&'static str),
    #[error("{0} sent an answer without a commit message")]
    NoAnswer(&'static str),
}

pub type Result<T> = std::result::Result<T, Error>;
