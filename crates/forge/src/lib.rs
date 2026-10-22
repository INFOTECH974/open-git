//! GitHub for Open GIT: the accounts and their tokens in the OS keychain, pull
//! requests, issues and workflow runs through the REST API, and the OAuth device
//! flow for signing in.
//!
//! Only GitHub for now; the types are generic enough for another forge later.

mod accounts;
mod actions;
mod askpass;
mod device;
mod error;
mod github;
mod remote;

pub use accounts::{
    Access, Accounts, account_token, activate_account, credentials, legacy_token, load_accounts,
    remove_account, save_account,
};
pub use actions::{CheckState, WorkflowJob, WorkflowRun, WorkflowStep};
pub use askpass::{ACCOUNT_ENV, Credential, Prompt, USERNAME_CONFIG, answer_prompt, parse_prompt};
pub use device::{DeviceCode, DevicePoll, poll_device, start_device_flow};
pub use error::{Error, Result};
pub use github::{
    Account, Comment, GitHub, Issue, ItemState, Label, PullRequest, RemoteRepository,
};
pub use remote::{GitHubRepo, github_https_url, parse_github_url};
