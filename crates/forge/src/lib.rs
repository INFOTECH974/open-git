//! GitHub for Open GIT: the account token in the OS keychain, pull requests,
//! issues and workflow runs through the REST API, and the OAuth device flow for
//! signing in.
//!
//! Only GitHub for now; the types are generic enough for another forge later.

mod actions;
mod askpass;
mod device;
mod error;
mod github;
mod remote;
mod token;

pub use actions::{CheckState, WorkflowJob, WorkflowRun, WorkflowStep};
pub use askpass::{Prompt, answer_prompt, parse_prompt};
pub use device::{DeviceCode, DevicePoll, poll_device, start_device_flow};
pub use error::{Error, Result};
pub use github::{
    Account, Comment, GitHub, Issue, ItemState, Label, PullRequest, RemoteRepository,
};
pub use remote::{GitHubRepo, parse_github_url};
pub use token::{clear_token, load_token, save_token};
