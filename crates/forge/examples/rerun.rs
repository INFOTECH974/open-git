//! Acts on a real workflow run with the active account of the keychain:
//! `cargo run -p open-git-forge --example rerun -- owner/name <run> rerun|failed|cancel`
//! starts the run (or only its failed jobs) again, or cancels it, then asks
//! for it every five seconds until it is over, as the UI does. With `job
//! <id>` instead, one job is started again. Without an action, the latest
//! runs are listed with their identifiers, to pick one.

use std::time::Duration;

use open_git_forge::{CheckState, GitHub, GitHubRepo, credentials};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let Some((owner, name)) = args.next().and_then(|repo| {
        repo.split_once('/')
            .map(|(o, n)| (o.to_owned(), n.to_owned()))
    }) else {
        println!("usage: rerun owner/name [<run> rerun|failed|cancel | job <id>]");
        return Ok(());
    };
    let Some(active) = credentials()?.into_iter().next() else {
        println!("no account is stored; sign in from the application first");
        return Ok(());
    };
    println!(
        "as {}",
        active.login.as_deref().unwrap_or("the stored token")
    );
    let github = GitHub::connect(&active.token)?;
    let repo = GitHubRepo { owner, name };

    let Some(target) = args.next() else {
        for run in github.workflow_runs(&repo).await? {
            println!(
                "{}  {:?}  {} #{} (attempt {})  {}  {}",
                run.id, run.state, run.workflow, run.number, run.attempt, run.branch, run.title
            );
        }
        return Ok(());
    };
    let action = args.next().unwrap_or_default();
    let run = if target == "job" {
        let job: u64 = action.parse()?;
        github.rerun_job(&repo, job).await?;
        println!("job {job}: started again");
        return Ok(());
    } else {
        target.parse::<u64>()?
    };
    let answer = match action.as_str() {
        "rerun" => github.rerun_workflow_run(&repo, run).await,
        "failed" => github.rerun_failed_jobs(&repo, run).await,
        "cancel" => github.cancel_workflow_run(&repo, run).await,
        other => {
            println!("unknown action `{other}`: rerun, failed or cancel");
            return Ok(());
        }
    };
    match answer {
        Ok(()) => println!("{action}: accepted"),
        Err(error) => {
            println!("{action}: {error}");
            return Ok(());
        }
    }

    // Then what GitHub makes of it, as the UI polls.
    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let runs = github.workflow_runs(&repo).await?;
        let Some(found) = runs.iter().find(|candidate| candidate.id == run) else {
            println!("run {run} is no longer listed");
            return Ok(());
        };
        print!(
            "{:?}  {} #{} attempt {}  {}s",
            found.state,
            found.workflow,
            found.number,
            found.attempt,
            found.updated_at - found.started_at
        );
        let jobs = github.workflow_jobs(&repo, run).await?;
        println!(
            "  jobs: {}",
            jobs.iter()
                .map(|job| format!("{} {:?}", job.name, job.state))
                .collect::<Vec<_>>()
                .join(", ")
        );
        if !matches!(found.state, CheckState::Queued | CheckState::InProgress) {
            return Ok(());
        }
    }
}
