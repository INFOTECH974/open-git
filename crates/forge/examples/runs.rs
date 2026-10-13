//! Asks the real GitHub what its Actions are doing for a repository, with the
//! active account of the keychain:
//! `cargo run -p open-git-forge --example runs -- owner/name` prints the latest
//! workflow runs, then the jobs and steps of the newest one. A number after the
//! repository asks again that many times, five seconds apart, as the UI does.

use std::time::Duration;

use open_git_forge::{GitHub, GitHubRepo, credentials};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let Some((owner, name)) = args.next().and_then(|repo| {
        repo.split_once('/')
            .map(|(o, n)| (o.to_owned(), n.to_owned()))
    }) else {
        println!("usage: runs owner/name [times]");
        return Ok(());
    };
    let times = args
        .next()
        .map(|times| times.parse::<usize>())
        .transpose()?
        .unwrap_or(1);
    let Some(active) = credentials()?.into_iter().next() else {
        println!("no account is stored; sign in from the application first");
        return Ok(());
    };
    let github = GitHub::connect(&active.token)?;
    let repo = GitHubRepo { owner, name };

    for round in 0..times {
        if round > 0 {
            tokio::time::sleep(Duration::from_secs(5)).await;
            println!();
        }
        let runs = github.workflow_runs(&repo).await?;
        println!("{} runs", runs.len());
        for run in &runs {
            println!(
                "{:?}  {} #{}  {}  {}  {}s  {}",
                run.state,
                run.workflow,
                run.number,
                run.branch,
                &run.commit[..run.commit.len().min(7)],
                run.updated_at - run.started_at,
                run.title
            );
        }
        let Some(newest) = runs.first() else {
            continue;
        };
        println!("jobs of {} #{}:", newest.workflow, newest.number);
        for job in github.workflow_jobs(&repo, newest.id).await? {
            println!("  {:?}  {}", job.state, job.name);
            for step in job.steps {
                println!("    {:>2}. {:?}  {}", step.number, step.state, step.name);
            }
        }
    }
    Ok(())
}
