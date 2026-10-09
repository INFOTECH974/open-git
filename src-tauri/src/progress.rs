//! Progress of the network operations (`fetch`, `pull`, `push`, `clone`),
//! relayed from git's `--progress` output to the frontend.

use serde::Serialize;
use tauri::AppHandle;
use tauri_specta::Event;

/// One line of git's progress output, such as `Receiving objects:  45% (123/273)`.
#[derive(Debug, Clone, Serialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct OperationProgress {
    /// The repository path (or the clone destination) the operation runs on.
    pub path: String,
    /// `fetch`, `pull`, `push` or `clone`.
    pub operation: String,
    pub message: String,
    /// Parsed from the line when it carries a percentage.
    pub percent: Option<u8>,
}

/// A callback that emits each progress line to the frontend.
pub fn reporter(app: AppHandle, path: String, operation: &'static str) -> impl FnMut(&str) {
    move |line: &str| {
        let message = line.trim();
        if message.is_empty() {
            return;
        }
        let _ = OperationProgress {
            path: path.clone(),
            operation: operation.to_owned(),
            message: message.to_owned(),
            percent: percent_of(message),
        }
        .emit(&app);
    }
}

/// The first `NN%` of a line, if any.
fn percent_of(line: &str) -> Option<u8> {
    let end = line.find('%')?;
    let digits: String = line[..end]
        .chars()
        .rev()
        .take_while(char::is_ascii_digit)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    digits.parse::<u8>().ok().filter(|value| *value <= 100)
}

#[cfg(test)]
mod tests {
    use super::percent_of;

    #[test]
    fn percent_is_read_from_git_lines() {
        assert_eq!(percent_of("Receiving objects:  45% (123/273)"), Some(45));
        assert_eq!(
            percent_of("Resolving deltas: 100% (50/50), done."),
            Some(100)
        );
        assert_eq!(percent_of("Cloning into 'repo'..."), None);
        assert_eq!(percent_of("remote: Counting objects: 3, done."), None);
    }
}
