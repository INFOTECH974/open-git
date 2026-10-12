//! GitHub Actions: the workflow runs of a repository, their jobs and their steps.
//!
//! GitHub has nothing to push to a desktop application, so the UI asks again
//! every few seconds while something runs; see [`GitHub::poll`].

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::{GitHub, GitHubRepo, Result};

/// Where a workflow run, a job or a step stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum CheckState {
    /// Not started: no runner took it yet, or the steps before it are not done.
    Queued,
    /// Held until someone approves it.
    Waiting,
    InProgress,
    Success,
    Failure,
    Cancelled,
    Skipped,
    /// Finished without a verdict, or in a state this version does not know.
    Neutral,
}

impl CheckState {
    /// From the `status` and `conclusion` GitHub gives runs, jobs and steps alike.
    fn new(status: Option<&str>, conclusion: Option<&str>) -> Self {
        match status.unwrap_or_default() {
            "completed" => match conclusion.unwrap_or_default() {
                "success" => Self::Success,
                "failure" | "timed_out" | "startup_failure" => Self::Failure,
                "cancelled" => Self::Cancelled,
                "skipped" => Self::Skipped,
                "action_required" => Self::Waiting,
                _ => Self::Neutral,
            },
            "in_progress" => Self::InProgress,
            "queued" | "requested" | "pending" => Self::Queued,
            "waiting" | "action_required" => Self::Waiting,
            _ => Self::Neutral,
        }
    }
}

/// One execution of a workflow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    pub id: u64,
    /// The workflow, as its file names it (`CI`).
    pub workflow: String,
    /// What the run is about: the commit summary, or the title of the pull request.
    pub title: String,
    /// Counts the runs of this workflow.
    pub number: u64,
    /// More than 1 once the run was started again.
    pub attempt: u32,
    /// What started it: `push`, `pull_request`, `schedule`…
    pub event: String,
    /// Empty when the run is not tied to a branch.
    pub branch: String,
    /// The commit the workflow runs on.
    pub commit: String,
    pub state: CheckState,
    pub actor: String,
    pub html_url: String,
    /// Seconds since the Unix epoch, for this attempt.
    pub started_at: i64,
    /// When it last changed: once finished, when it ended.
    pub updated_at: i64,
}

/// One job of a run, with the steps it goes through.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct WorkflowJob {
    pub id: u64,
    pub name: String,
    pub state: CheckState,
    pub html_url: String,
    /// Seconds since the Unix epoch; `None` until a runner starts it.
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub steps: Vec<WorkflowStep>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStep {
    /// Its place in the job, from 1.
    pub number: u32,
    pub name: String,
    pub state: CheckState,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
}

/// How many runs are listed: enough to cover the commits at the top of the graph.
const RUNS: u8 = 30;
/// GitHub's largest page; a run with more jobs than that shows its first hundred.
const JOBS: u8 = 100;

impl GitHub {
    /// The latest workflow runs of the repository, on any branch, newest first.
    pub async fn workflow_runs(&self, repo: &GitHubRepo) -> Result<Vec<WorkflowRun>> {
        let route = format!(
            "/repos/{}/{}/actions/runs?per_page={RUNS}&exclude_pull_requests=true",
            repo.owner, repo.name
        );
        self.poll(&route, |page: RunsPage| {
            page.workflow_runs.into_iter().map(workflow_run).collect()
        })
        .await
    }

    /// The jobs of the latest attempt of a run, in the order GitHub lists them.
    pub async fn workflow_jobs(&self, repo: &GitHubRepo, run: u64) -> Result<Vec<WorkflowJob>> {
        let route = format!(
            "/repos/{}/{}/actions/runs/{run}/jobs?per_page={JOBS}",
            repo.owner, repo.name
        );
        self.poll(&route, |page: JobsPage| {
            page.jobs.into_iter().map(workflow_job).collect()
        })
        .await
    }
}

// What GitHub sends, read leniently: one run without a branch, a name or a
// commit must not hide the others, and most of each object is of no use here.

#[derive(Deserialize)]
struct RunsPage {
    #[serde(default)]
    workflow_runs: Vec<RawRun>,
}

#[derive(Deserialize)]
struct RawRun {
    id: u64,
    name: Option<String>,
    display_title: Option<String>,
    /// `.github/workflows/ci.yml`: names the workflow when it has no `name`.
    path: Option<String>,
    run_number: Option<u64>,
    run_attempt: Option<u32>,
    event: Option<String>,
    head_branch: Option<String>,
    head_sha: Option<String>,
    status: Option<String>,
    conclusion: Option<String>,
    html_url: Option<String>,
    actor: Option<RawActor>,
    created_at: Option<DateTime<Utc>>,
    run_started_at: Option<DateTime<Utc>>,
    updated_at: Option<DateTime<Utc>>,
}

#[derive(Deserialize)]
struct RawActor {
    login: Option<String>,
}

#[derive(Deserialize)]
struct JobsPage {
    #[serde(default)]
    jobs: Vec<RawJob>,
}

#[derive(Deserialize)]
struct RawJob {
    id: u64,
    name: Option<String>,
    status: Option<String>,
    conclusion: Option<String>,
    html_url: Option<String>,
    started_at: Option<DateTime<Utc>>,
    completed_at: Option<DateTime<Utc>>,
    steps: Option<Vec<RawStep>>,
}

#[derive(Deserialize)]
struct RawStep {
    number: Option<u32>,
    name: Option<String>,
    status: Option<String>,
    conclusion: Option<String>,
    started_at: Option<DateTime<Utc>>,
    completed_at: Option<DateTime<Utc>>,
}

fn seconds(time: DateTime<Utc>) -> i64 {
    time.timestamp()
}

fn workflow_run(run: RawRun) -> WorkflowRun {
    let workflow = run
        .name
        .filter(|name| !name.is_empty())
        .or(run.path)
        .unwrap_or_default();
    // A run that was started again keeps its creation date; the attempt has its own.
    let started_at = run.run_started_at.or(run.created_at);
    WorkflowRun {
        id: run.id,
        title: run
            .display_title
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| workflow.clone()),
        workflow,
        number: run.run_number.unwrap_or_default(),
        attempt: run.run_attempt.unwrap_or(1),
        event: run.event.unwrap_or_default(),
        branch: run.head_branch.unwrap_or_default(),
        commit: run.head_sha.unwrap_or_default(),
        state: CheckState::new(run.status.as_deref(), run.conclusion.as_deref()),
        actor: run.actor.and_then(|actor| actor.login).unwrap_or_default(),
        html_url: run.html_url.unwrap_or_default(),
        started_at: started_at.map(seconds).unwrap_or_default(),
        updated_at: run
            .updated_at
            .or(started_at)
            .map(seconds)
            .unwrap_or_default(),
    }
}

fn workflow_job(job: RawJob) -> WorkflowJob {
    let state = CheckState::new(job.status.as_deref(), job.conclusion.as_deref());
    WorkflowJob {
        id: job.id,
        name: job.name.unwrap_or_default(),
        state,
        html_url: job.html_url.unwrap_or_default(),
        // GitHub dates a job that waits for a runner from its creation.
        started_at: job
            .started_at
            .filter(|_| state != CheckState::Queued)
            .map(seconds),
        completed_at: job.completed_at.map(seconds),
        steps: job
            .steps
            .unwrap_or_default()
            .into_iter()
            .zip(1..)
            .map(|(step, position)| WorkflowStep {
                number: step.number.unwrap_or(position),
                name: step.name.unwrap_or_default(),
                state: CheckState::new(step.status.as_deref(), step.conclusion.as_deref()),
                started_at: step.started_at.map(seconds),
                completed_at: step.completed_at.map(seconds),
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_and_conclusion_fold_into_one_state() {
        let state = |status, conclusion| CheckState::new(Some(status), conclusion);
        assert_eq!(state("queued", None), CheckState::Queued);
        assert_eq!(state("requested", None), CheckState::Queued);
        assert_eq!(state("pending", None), CheckState::Queued);
        assert_eq!(state("waiting", None), CheckState::Waiting);
        assert_eq!(state("in_progress", None), CheckState::InProgress);
        assert_eq!(state("completed", Some("success")), CheckState::Success);
        assert_eq!(state("completed", Some("failure")), CheckState::Failure);
        assert_eq!(state("completed", Some("timed_out")), CheckState::Failure);
        assert_eq!(
            state("completed", Some("startup_failure")),
            CheckState::Failure
        );
        assert_eq!(state("completed", Some("cancelled")), CheckState::Cancelled);
        assert_eq!(state("completed", Some("skipped")), CheckState::Skipped);
        assert_eq!(
            state("completed", Some("action_required")),
            CheckState::Waiting
        );
        assert_eq!(state("completed", Some("neutral")), CheckState::Neutral);
        assert_eq!(state("completed", Some("stale")), CheckState::Neutral);
        // What GitHub may add later is shown, not refused.
        assert_eq!(state("completed", Some("brand_new")), CheckState::Neutral);
        assert_eq!(state("brand_new", None), CheckState::Neutral);
        assert_eq!(CheckState::new(None, None), CheckState::Neutral);
    }

    #[test]
    fn runs_are_read_from_what_github_sends() {
        // Trimmed from a real answer; the fields left out are ignored anyway.
        let page: RunsPage = serde_json::from_str(
            r#"{
                "total_count": 2,
                "workflow_runs": [
                    {
                        "id": 18431216543,
                        "name": "CI",
                        "node_id": "WFR_kwLOP",
                        "head_branch": "main",
                        "head_sha": "341d179b0c5b3f9d6a1e2f1c7c0c4f3f5b6a7d8e",
                        "path": ".github/workflows/ci.yml",
                        "display_title": "Write latest.json once per release",
                        "run_number": 42,
                        "event": "push",
                        "status": "in_progress",
                        "conclusion": null,
                        "workflow_id": 1234,
                        "html_url": "https://github.com/me/repo/actions/runs/18431216543",
                        "pull_requests": [],
                        "created_at": "2026-10-12T08:00:00Z",
                        "updated_at": "2026-10-12T08:01:30Z",
                        "actor": { "login": "ada", "id": 1 },
                        "run_attempt": 2,
                        "run_started_at": "2026-10-12T08:01:00Z",
                        "head_commit": null,
                        "repository": { "id": 1, "full_name": "me/repo" }
                    },
                    {
                        "id": 7,
                        "name": null,
                        "head_branch": null,
                        "path": ".github/workflows/release.yml",
                        "status": "completed",
                        "conclusion": "failure",
                        "created_at": "2026-10-11T10:00:00Z",
                        "updated_at": "2026-10-11T10:04:00Z"
                    }
                ]
            }"#,
        )
        .unwrap();
        let runs: Vec<_> = page.workflow_runs.into_iter().map(workflow_run).collect();

        assert_eq!(
            runs[0],
            WorkflowRun {
                id: 18_431_216_543,
                workflow: "CI".to_owned(),
                title: "Write latest.json once per release".to_owned(),
                number: 42,
                attempt: 2,
                event: "push".to_owned(),
                branch: "main".to_owned(),
                commit: "341d179b0c5b3f9d6a1e2f1c7c0c4f3f5b6a7d8e".to_owned(),
                state: CheckState::InProgress,
                actor: "ada".to_owned(),
                html_url: "https://github.com/me/repo/actions/runs/18431216543".to_owned(),
                // The second attempt started a minute after the run was created.
                started_at: 1_791_792_060,
                updated_at: 1_791_792_090,
            }
        );
        // A run with almost nothing still shows up, named after its file.
        assert_eq!(runs[1].workflow, ".github/workflows/release.yml");
        assert_eq!(runs[1].title, ".github/workflows/release.yml");
        assert_eq!(runs[1].branch, "");
        assert_eq!(runs[1].attempt, 1);
        assert_eq!(runs[1].state, CheckState::Failure);
        assert_eq!(runs[1].updated_at - runs[1].started_at, 240);
    }

    #[test]
    fn jobs_and_steps_are_read_from_what_github_sends() {
        let page: JobsPage = serde_json::from_str(
            r#"{
                "total_count": 2,
                "jobs": [
                    {
                        "id": 51,
                        "run_id": 18431216543,
                        "name": "test (ubuntu-latest)",
                        "status": "in_progress",
                        "conclusion": null,
                        "html_url": "https://github.com/me/repo/actions/runs/18431216543/job/51",
                        "created_at": "2026-10-12T08:01:00Z",
                        "started_at": "2026-10-12T08:01:05Z",
                        "completed_at": null,
                        "steps": [
                            {
                                "name": "Set up job",
                                "status": "completed",
                                "conclusion": "success",
                                "number": 1,
                                "started_at": "2026-10-12T08:01:05.000Z",
                                "completed_at": "2026-10-12T08:01:07.000Z"
                            },
                            {
                                "name": "cargo test",
                                "status": "in_progress",
                                "conclusion": null,
                                "number": 2,
                                "started_at": "2026-10-12T08:01:07.000Z",
                                "completed_at": null
                            },
                            {
                                "name": "Post checkout",
                                "status": "queued",
                                "conclusion": null,
                                "number": 3,
                                "started_at": null,
                                "completed_at": null
                            }
                        ]
                    },
                    {
                        "id": 52,
                        "name": "build",
                        "status": "queued",
                        "conclusion": null,
                        "started_at": "2026-10-12T08:01:00Z",
                        "completed_at": null
                    }
                ]
            }"#,
        )
        .unwrap();
        let jobs: Vec<_> = page.jobs.into_iter().map(workflow_job).collect();

        assert_eq!(jobs[0].name, "test (ubuntu-latest)");
        assert_eq!(jobs[0].state, CheckState::InProgress);
        assert_eq!(jobs[0].started_at, Some(1_791_792_065));
        assert_eq!(jobs[0].completed_at, None);
        let steps: Vec<_> = jobs[0]
            .steps
            .iter()
            .map(|step| (step.number, step.name.as_str(), step.state))
            .collect();
        assert_eq!(
            steps,
            [
                (1, "Set up job", CheckState::Success),
                (2, "cargo test", CheckState::InProgress),
                (3, "Post checkout", CheckState::Queued),
            ]
        );
        assert_eq!(jobs[0].steps[0].completed_at, Some(1_791_792_067));
        assert_eq!(jobs[0].steps[2].started_at, None);

        // Waiting for a runner: no steps yet, and no start worth a duration.
        assert_eq!(jobs[1].state, CheckState::Queued);
        assert_eq!(jobs[1].started_at, None);
        assert!(jobs[1].steps.is_empty());
    }
}
