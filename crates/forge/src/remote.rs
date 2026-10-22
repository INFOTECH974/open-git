use serde::Serialize;

/// A repository on github.com, as `owner/name`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct GitHubRepo {
    pub owner: String,
    pub name: String,
}

impl GitHubRepo {
    pub fn html_url(&self) -> String {
        format!("https://github.com/{}/{}", self.owner, self.name)
    }
}

/// Reads `owner/name` out of the URL forms git accepts for GitHub:
/// `https://github.com/owner/name.git`, `git@github.com:owner/name.git`,
/// `ssh://git@github.com/owner/name`, with or without `.git` and a trailing slash.
pub fn parse_github_url(url: &str) -> Option<GitHubRepo> {
    let url = url.trim();
    let rest = url
        .strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("http://github.com/"))
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))
        .or_else(|| url.strip_prefix("git@github.com:"))
        .or_else(|| url.strip_prefix("github.com/"))?;
    let rest = rest.trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let mut parts = rest.split('/');
    let owner = parts.next().filter(|owner| !owner.is_empty())?;
    let name = parts.next().filter(|name| !name.is_empty())?;
    if parts.next().is_some() {
        return None;
    }
    Some(GitHubRepo {
        owner: owner.to_owned(),
        name: name.to_owned(),
    })
}

/// The HTTPS address of a GitHub repository given by an SSH URL
/// (`git@github.com:owner/name.git`, `ssh://git@github.com/owner/name`), or
/// `None` for any other URL. Over HTTPS, the accounts connected in the
/// application answer `git`; over SSH only a key can.
pub fn github_https_url(url: &str) -> Option<String> {
    let url = url.trim();
    if !(url.starts_with("git@github.com:") || url.starts_with("ssh://git@github.com/")) {
        return None;
    }
    parse_github_url(url).map(|repo| format!("{}.git", repo.html_url()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_urls_of_github_get_their_https_form() {
        assert_eq!(
            github_https_url("git@github.com:me/repo.git").as_deref(),
            Some("https://github.com/me/repo.git")
        );
        assert_eq!(
            github_https_url("ssh://git@github.com/me/repo").as_deref(),
            Some("https://github.com/me/repo.git")
        );
        assert_eq!(github_https_url("https://github.com/me/repo.git"), None);
        assert_eq!(github_https_url("git@gitlab.com:me/repo.git"), None);
    }

    fn repo(owner: &str, name: &str) -> Option<GitHubRepo> {
        Some(GitHubRepo {
            owner: owner.to_owned(),
            name: name.to_owned(),
        })
    }

    #[test]
    fn github_urls_in_every_form_are_recognised() {
        assert_eq!(
            parse_github_url("https://github.com/me/repo.git"),
            repo("me", "repo")
        );
        assert_eq!(
            parse_github_url("https://github.com/me/repo"),
            repo("me", "repo")
        );
        assert_eq!(
            parse_github_url("https://github.com/me/repo/"),
            repo("me", "repo")
        );
        assert_eq!(
            parse_github_url("git@github.com:me/repo.git"),
            repo("me", "repo")
        );
        assert_eq!(
            parse_github_url("ssh://git@github.com/me/repo.git"),
            repo("me", "repo")
        );
        assert_eq!(
            parse_github_url("  github.com/me/repo  "),
            repo("me", "repo")
        );
    }

    #[test]
    fn other_hosts_and_malformed_urls_are_rejected() {
        assert_eq!(parse_github_url("https://gitlab.com/me/repo.git"), None);
        assert_eq!(parse_github_url("https://github.com/me"), None);
        assert_eq!(parse_github_url("https://github.com/me/repo/extra"), None);
        assert_eq!(parse_github_url("git@github.com:/repo.git"), None);
        assert_eq!(parse_github_url(""), None);
    }

    #[test]
    fn html_url_points_at_the_repository_page() {
        assert_eq!(
            repo("me", "repo").unwrap().html_url(),
            "https://github.com/me/repo"
        );
    }
}
