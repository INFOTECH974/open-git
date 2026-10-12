//! A language model for Open GIT: it reads the staged changes and proposes a
//! commit message.
//!
//! The model is reached with an API key the user brings, from Anthropic
//! (Claude) or OpenAI, kept in the OS keychain; or through the Claude Code or
//! Codex program already installed and signed in on the machine. Nothing is
//! sent anywhere until the user asks for a message.

mod cli;
mod commit;
mod error;
mod key;
mod provider;

pub use cli::{cli_available, cli_models};
pub use commit::{Changes, CommitSuggestion, suggest_commit_message};
pub use error::{Error, Result};
pub use key::{clear_key, load_key, save_key};
pub use provider::{AiModel, Provider, complete, list_models};
