//! Asks the real GitHub what each account of the keychain may do with
//! repositories: `cargo run -p open-git-forge --example access -- owner/name …`
//! prints, account by account, whether GitHub still accepts its token, then
//! `Write`, `Read`, `Hidden` or `Refused` for each repository: what the
//! application chooses the account of a repository from.

use open_git_forge::{GitHub, GitHubRepo, credentials};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let repos: Vec<GitHubRepo> = std::env::args()
        .skip(1)
        .filter_map(|repo| {
            let (owner, name) = repo.split_once('/')?;
            Some(GitHubRepo {
                owner: owner.to_owned(),
                name: name.to_owned(),
            })
        })
        .collect();
    let stored = credentials()?;
    if stored.is_empty() {
        println!("no account is stored; sign in from the application first");
        return Ok(());
    }
    for credential in stored {
        let login = credential
            .login
            .as_deref()
            .unwrap_or("(single-account entry)");
        let github = GitHub::connect(&credential.token)?;
        match github.account().await {
            Ok(account) => println!("{login}: token accepted (signed in as {})", account.login),
            Err(error) => println!("{login}: {error}"),
        }
        for repo in &repos {
            match github.access(repo).await {
                Ok(access) => println!("  {}/{}: {access:?}", repo.owner, repo.name),
                Err(error) => println!("  {}/{}: {error}", repo.owner, repo.name),
            }
        }
    }
    Ok(())
}
