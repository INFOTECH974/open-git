//! Asks a real model for the commit message of what is staged in a repository:
//! `cargo run -p open-git-ai --example suggest -- anthropic claude-opus-5-5 ../a-repository`
//! (the current directory without a path; `models` instead of a model id lists
//! what can be chosen).
//!
//! `anthropic` and `openai` use the key stored from the application, or else
//! `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` from the environment. `claude` and
//! `codex` run the program of that name; `default` as the model leaves it its own.

use open_git_ai::{Changes, Provider, cli_models, list_models, load_key, suggest_commit_message};
use open_git_core::Repo;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let (provider, variable) = match args.next().as_deref() {
        Some("anthropic") => (Provider::Anthropic, Some("ANTHROPIC_API_KEY")),
        Some("openai") => (Provider::OpenAi, Some("OPENAI_API_KEY")),
        Some("claude") => (Provider::ClaudeCode, None),
        Some("codex") => (Provider::Codex, None),
        _ => {
            return Err(
                "usage: suggest <anthropic|openai|claude|codex> <model|default|models> [repository]"
                    .into(),
            );
        }
    };
    let model = args.next().ok_or("which model? (`models` lists them)")?;
    let key = match variable {
        Some(variable) => {
            let Some(key) = load_key(provider)?.or_else(|| std::env::var(variable).ok()) else {
                println!(
                    "no {} key is stored, and {variable} is not set",
                    provider.label()
                );
                return Ok(());
            };
            Some(key)
        }
        None => None,
    };

    if model == "models" {
        let models = match &key {
            Some(key) => list_models(provider, key).await?,
            None => cli_models(provider),
        };
        for model in models {
            println!("{}  {}", model.id, model.name);
        }
        return Ok(());
    }
    let model = if model == "default" { "" } else { &model };

    let repo = Repo::open(args.next().unwrap_or_else(|| ".".to_owned()))?;
    let staged = repo.staged_changes(false)?;
    let changes = Changes {
        files: &staged.files,
        patch: &staged.patch,
        recent_subjects: &staged.recent_subjects,
    };
    let suggestion = suggest_commit_message(provider, key.as_deref(), model, changes).await?;
    println!("{}", suggestion.summary);
    if !suggestion.body.is_empty() {
        println!("\n{}", suggestion.body);
    }
    if suggestion.shortened_files > 0 {
        println!(
            "\n({} files had their diff shortened)",
            suggestion.shortened_files
        );
    }
    Ok(())
}
