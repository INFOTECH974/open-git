//! The GitHub REST API, reduced to what the UI shows.

use std::{
    any::Any,
    collections::HashMap,
    sync::{Arc, Mutex, PoisonError},
};

use http::{HeaderMap, StatusCode};
use octocrab::{FromResponse, Octocrab, etag::EntityTag, models, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::{GitHubRepo, Result};

/// The signed-in user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub login: String,
    pub avatar_url: String,
    pub html_url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum ItemState {
    Open,
    Closed,
}

impl From<Option<models::IssueState>> for ItemState {
    fn from(state: Option<models::IssueState>) -> Self {
        match state {
            Some(models::IssueState::Closed) => Self::Closed,
            _ => Self::Open,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct Label {
    pub name: String,
    /// Six hex digits, as GitHub stores it.
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub body: String,
    pub state: ItemState,
    pub draft: bool,
    pub merged: bool,
    pub author: String,
    /// Branch the changes come from.
    pub head: String,
    /// Branch the changes go into.
    pub base: String,
    pub html_url: String,
    /// Seconds since the Unix epoch.
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub number: u64,
    pub title: String,
    pub body: String,
    pub state: ItemState,
    pub author: String,
    pub labels: Vec<Label>,
    pub comments: u32,
    pub html_url: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: u64,
    pub author: String,
    pub body: String,
    pub html_url: String,
    pub created_at: i64,
}

/// A repository the account can reach, as offered for cloning.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct RemoteRepository {
    /// `owner/name`.
    pub full_name: String,
    pub description: String,
    pub private: bool,
    pub fork: bool,
    pub archived: bool,
    /// The HTTPS address to clone from.
    pub clone_url: String,
    /// Seconds since the Unix epoch; 0 for a repository nothing was pushed to.
    pub pushed_at: i64,
}

/// A connected GitHub account. Cheap to clone: the client is reference-counted.
#[derive(Clone)]
pub struct GitHub {
    client: Octocrab,
    polled: Arc<Polled>,
}

/// The last answer to each polled route, with the tag GitHub gave it.
type Polled = Mutex<HashMap<String, (EntityTag, Box<dyn Any + Send + Sync>)>>;
/// Past this many answers the memory starts over, rather than tracking their age.
const POLLED_ROUTES: usize = 64;

const PAGE: u8 = 50;
/// GitHub's largest page, and how many of them a repository list may span.
const REPOSITORY_PAGE: u8 = 100;
const REPOSITORY_PAGES: usize = 10;

impl GitHub {
    /// Connects with a personal access token or an OAuth token.
    pub fn connect(token: &str) -> Result<Self> {
        let client = Octocrab::builder()
            .personal_token(token.to_owned())
            .build()?;
        Ok(Self {
            client,
            polled: Arc::default(),
        })
    }

    /// A `GET` meant to be repeated every few seconds. It carries the tag of the
    /// last answer, so that GitHub replies `304 Not Modified` when nothing
    /// changed: such an answer does not count against the rate limit. `convert`
    /// keeps what matters of a new answer, which is also what is remembered.
    pub(crate) async fn poll<R, T>(&self, route: &str, convert: impl FnOnce(R) -> T) -> Result<T>
    where
        R: DeserializeOwned,
        T: Clone + Send + Sync + 'static,
    {
        let mut headers = HeaderMap::new();
        if let Some(tag) = self.polled_tag(route) {
            EntityTag::insert_if_none_match_header(&mut headers, tag)?;
        }
        let mut response = self.client._get_with_headers(route, Some(headers)).await?;
        if response.status() == StatusCode::NOT_MODIFIED {
            if let Some(known) = self.polled_answer(route) {
                return Ok(known);
            }
            // The memory started over between the two locks: ask plainly.
            response = self.client._get(route).await?;
        }
        let tag = EntityTag::extract_from_response(&response);
        let answer = convert(R::from_response(octocrab::map_github_error(response).await?).await?);
        if let Some(tag) = tag {
            let mut polled = self.polled.lock().unwrap_or_else(PoisonError::into_inner);
            if polled.len() >= POLLED_ROUTES && !polled.contains_key(route) {
                polled.clear();
            }
            polled.insert(route.to_owned(), (tag, Box::new(answer.clone())));
        }
        Ok(answer)
    }

    fn polled_tag(&self, route: &str) -> Option<EntityTag> {
        let polled = self.polled.lock().unwrap_or_else(PoisonError::into_inner);
        polled.get(route).map(|(tag, _)| tag.clone())
    }

    fn polled_answer<T: Clone + 'static>(&self, route: &str) -> Option<T> {
        let polled = self.polled.lock().unwrap_or_else(PoisonError::into_inner);
        polled.get(route)?.1.downcast_ref::<T>().cloned()
    }

    /// The user the token belongs to; fails when the token is invalid.
    pub async fn account(&self) -> Result<Account> {
        let user = self.client.current().user().await?;
        Ok(Account {
            login: user.login,
            avatar_url: user.avatar_url.to_string(),
            html_url: user.html_url.to_string(),
        })
    }

    /// The repositories the account owns, collaborates on or reaches through an
    /// organisation, most recently pushed first.
    pub async fn repositories(&self) -> Result<Vec<RemoteRepository>> {
        let mut page = self
            .client
            .current()
            .list_repos_for_authenticated_user()
            .sort("pushed")
            .per_page(REPOSITORY_PAGE)
            .send()
            .await?;
        let mut found = page.take_items();
        for _ in 1..REPOSITORY_PAGES {
            let Some(mut next) = self
                .client
                .get_page::<models::Repository>(&page.next)
                .await?
            else {
                break;
            };
            found.append(&mut next.take_items());
            page = next;
        }
        Ok(found.into_iter().filter_map(remote_repository).collect())
    }

    pub async fn pull_requests(
        &self,
        repo: &GitHubRepo,
        state: ItemState,
    ) -> Result<Vec<PullRequest>> {
        let page = self
            .client
            .pulls(&repo.owner, &repo.name)
            .list()
            .state(match state {
                ItemState::Open => params::State::Open,
                ItemState::Closed => params::State::Closed,
            })
            .sort(params::pulls::Sort::Updated)
            .direction(params::Direction::Descending)
            .per_page(PAGE)
            .send()
            .await?;
        Ok(page.items.into_iter().map(pull_request).collect())
    }

    pub async fn create_pull_request(
        &self,
        repo: &GitHubRepo,
        title: &str,
        body: &str,
        head: &str,
        base: &str,
        draft: bool,
    ) -> Result<PullRequest> {
        let created = self
            .client
            .pulls(&repo.owner, &repo.name)
            .create(title, head, base)
            .body::<String>(Some(body.to_owned()))
            .draft(Some(draft))
            .send()
            .await?;
        Ok(pull_request(created))
    }

    /// Issues only: GitHub lists pull requests among issues, they are filtered out.
    pub async fn issues(&self, repo: &GitHubRepo, state: ItemState) -> Result<Vec<Issue>> {
        let page = self
            .client
            .issues(&repo.owner, &repo.name)
            .list()
            .state(match state {
                ItemState::Open => params::State::Open,
                ItemState::Closed => params::State::Closed,
            })
            .sort(params::issues::Sort::Updated)
            .direction(params::Direction::Descending)
            .per_page(PAGE)
            .send()
            .await?;
        Ok(page
            .items
            .into_iter()
            .filter(|item| item.pull_request.is_none())
            .map(issue)
            .collect())
    }

    pub async fn create_issue(&self, repo: &GitHubRepo, title: &str, body: &str) -> Result<Issue> {
        let created = self
            .client
            .issues(&repo.owner, &repo.name)
            .create(title)
            .body(body)
            .send()
            .await?;
        Ok(issue(created))
    }

    pub async fn comment_issue(
        &self,
        repo: &GitHubRepo,
        number: u64,
        body: &str,
    ) -> Result<Comment> {
        let created = self
            .client
            .issues(&repo.owner, &repo.name)
            .create_comment(number, body)
            .await?;
        Ok(comment(created))
    }

    pub async fn issue_comments(&self, repo: &GitHubRepo, number: u64) -> Result<Vec<Comment>> {
        let page = self
            .client
            .issues(&repo.owner, &repo.name)
            .list_comments(number)
            .per_page(PAGE)
            .send()
            .await?;
        Ok(page.items.into_iter().map(comment).collect())
    }

    pub async fn close_issue(&self, repo: &GitHubRepo, number: u64) -> Result<Issue> {
        let updated = self
            .client
            .issues(&repo.owner, &repo.name)
            .update(number)
            .state(models::IssueState::Closed)
            .send()
            .await?;
        Ok(issue(updated))
    }
}

fn seconds(time: Option<chrono::DateTime<chrono::Utc>>) -> i64 {
    time.map(|time| time.timestamp()).unwrap_or_default()
}

/// `None` for an entry GitHub sent without an address to clone from.
fn remote_repository(repo: models::Repository) -> Option<RemoteRepository> {
    Some(RemoteRepository {
        clone_url: repo.clone_url?.to_string(),
        full_name: repo.full_name.unwrap_or(repo.name),
        description: repo.description.unwrap_or_default(),
        private: repo.private.unwrap_or(false),
        fork: repo.fork.unwrap_or(false),
        archived: repo.archived.unwrap_or(false),
        pushed_at: seconds(repo.pushed_at),
    })
}

fn pull_request(pr: models::pulls::PullRequest) -> PullRequest {
    PullRequest {
        number: pr.number,
        title: pr.title.unwrap_or_default(),
        body: pr.body.unwrap_or_default(),
        state: pr.state.into(),
        draft: pr.draft.unwrap_or(false),
        merged: pr.merged_at.is_some(),
        author: pr.user.map(|user| user.login).unwrap_or_default(),
        head: pr.head.ref_field,
        base: pr.base.ref_field,
        html_url: pr.html_url.map(|url| url.to_string()).unwrap_or_default(),
        created_at: seconds(pr.created_at),
        updated_at: seconds(pr.updated_at),
    }
}

fn issue(item: models::issues::Issue) -> Issue {
    Issue {
        number: item.number,
        title: item.title,
        body: item.body.unwrap_or_default(),
        state: Some(item.state).into(),
        author: item.user.login,
        labels: item
            .labels
            .into_iter()
            .map(|label| Label {
                name: label.name,
                color: label.color,
            })
            .collect(),
        comments: item.comments,
        html_url: item.html_url.to_string(),
        created_at: item.created_at.timestamp(),
        updated_at: item.updated_at.timestamp(),
    }
}

fn comment(item: models::issues::Comment) -> Comment {
    Comment {
        id: item.id.into_inner(),
        author: item.user.login,
        body: item.body.unwrap_or_default(),
        html_url: item.html_url.to_string(),
        created_at: item.created_at.timestamp(),
    }
}
