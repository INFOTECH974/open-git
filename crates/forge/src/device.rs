//! GitHub's OAuth device flow: the application shows a code, the user types it
//! on github.com, and the application polls until a token comes back.
//!
//! It needs the client id of an OAuth App registered on GitHub; without one the
//! user can still paste a personal access token.

use serde::{Deserialize, Serialize};

use crate::{Error, Result};

const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
/// Enough for private repositories, pull requests and issues.
const SCOPES: &str = "repo read:user";

/// What GitHub hands out at the start of the flow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct DeviceCode {
    /// Opaque, sent back when polling.
    pub device_code: String,
    /// What the user types on the verification page.
    pub user_code: String,
    pub verification_uri: String,
    /// Seconds to wait between two polls.
    pub interval: u32,
    /// Seconds before the codes expire.
    pub expires_in: u32,
}

/// The answer to one poll.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum DevicePoll {
    /// The user has not finished yet; poll again after `interval`.
    Pending,
    /// Polled too fast; add five seconds to the interval.
    SlowDown,
    /// Signed in: the token to keep.
    Token(String),
    /// The codes expired or the user refused; start over.
    Failed(String),
}

fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder().user_agent("open-git").build()?)
}

pub async fn start_device_flow(client_id: &str) -> Result<DeviceCode> {
    #[derive(Deserialize)]
    struct Response {
        device_code: String,
        user_code: String,
        verification_uri: String,
        interval: u32,
        expires_in: u32,
    }
    let response: Response = client()?
        .post(DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .form(&[("client_id", client_id), ("scope", SCOPES)])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(DeviceCode {
        device_code: response.device_code,
        user_code: response.user_code,
        verification_uri: response.verification_uri,
        interval: response.interval,
        expires_in: response.expires_in,
    })
}

pub async fn poll_device(client_id: &str, device_code: &str) -> Result<DevicePoll> {
    #[derive(Deserialize)]
    struct Response {
        access_token: Option<String>,
        error: Option<String>,
        error_description: Option<String>,
    }
    let response: Response = client()?
        .post(ACCESS_TOKEN_URL)
        .header("Accept", "application/json")
        .form(&[
            ("client_id", client_id),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await?
        .json()
        .await?;
    if let Some(token) = response.access_token {
        return Ok(DevicePoll::Token(token));
    }
    Ok(match response.error.as_deref() {
        Some("authorization_pending") => DevicePoll::Pending,
        Some("slow_down") => DevicePoll::SlowDown,
        Some("expired_token") => DevicePoll::Failed("the code expired; start again".to_owned()),
        Some("access_denied") => DevicePoll::Failed("the sign-in was refused on GitHub".to_owned()),
        Some(other) => {
            return Err(Error::Device(
                response
                    .error_description
                    .unwrap_or_else(|| other.to_owned()),
            ));
        }
        None => {
            return Err(Error::Device(
                "GitHub sent neither a token nor an error".to_owned(),
            ));
        }
    })
}
