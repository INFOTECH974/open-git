//! Prints what the UI would receive for a repository, as JSON.
//!
//! ```text
//! cargo run -p open-git-core --example dump -- path/to/repo [rows]
//! ```

use open_git_core::Repo;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let path = args.next().unwrap_or_else(|| ".".into());
    let rows: u32 = args.next().map(|n| n.parse()).transpose()?.unwrap_or(20);

    let started = std::time::Instant::now();
    let mut repo = Repo::open(&path)?;
    let info = repo.info()?;
    let refs = repo.refs()?;
    let count = repo.commit_count()?;
    let graph = repo.graph_rows(0, rows)?;
    let walked = started.elapsed();

    let details = graph
        .first()
        .map(|row| repo.commit_details(&row.id))
        .transpose()?;
    let diff = details
        .as_ref()
        .and_then(|d| {
            d.files
                .first()
                .map(|f| repo.commit_file_diff(&d.id, &f.path))
        })
        .transpose()?;

    let output = serde_json::json!({
        "info": info,
        "refs": refs,
        "commitCount": count,
        "graph": graph,
        "details": details,
        "diff": diff,
    });
    println!("{}", serde_json::to_string_pretty(&output)?);
    eprintln!(
        "{count} commits walked and {rows} rows laid out in {walked:?}; total {:?}",
        started.elapsed()
    );
    Ok(())
}
