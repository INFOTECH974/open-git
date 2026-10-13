//! Asks the real GitHub what the active account of the keychain can clone:
//! `cargo run -p open-git-forge --example repositories -- 10` prints the ten most
//! recently pushed repositories; without a number, only how many there are.

use open_git_forge::{GitHub, credentials};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let shown = std::env::args()
        .nth(1)
        .map(|count| count.parse::<usize>())
        .transpose()?
        .unwrap_or(0);
    let Some(active) = credentials()?.into_iter().next() else {
        println!("no account is stored; sign in from the application first");
        return Ok(());
    };
    let github = GitHub::connect(&active.token)?;
    println!("account: {}", github.account().await?.login);

    let repositories = github.repositories().await?;
    let private = repositories.iter().filter(|repo| repo.private).count();
    println!("{} repositories, {private} private", repositories.len());
    for repo in repositories.iter().take(shown) {
        println!(
            "{}{}  {}",
            repo.full_name,
            if repo.private { " (private)" } else { "" },
            repo.clone_url
        );
    }
    Ok(())
}
