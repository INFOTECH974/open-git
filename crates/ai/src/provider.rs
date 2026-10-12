//! Who can write a message, and the two that are reached over HTTP with a key.
//! The other two are programs on the machine, see [`crate::cli`].
//!
//! Neither API has an official Rust SDK, so this speaks HTTP directly:
//! Anthropic's Messages API and OpenAI's Chat Completions.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{Error, Result};

const ANTHROPIC_API: &str = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const OPENAI_API: &str = "https://api.openai.com/v1";

/// Lets Anthropic re-run a request its safety classifiers declined on another
/// model, instead of failing; a diff that touches security code can trip them.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
/// The models that accept `fallbacks`.
const FALLBACK_MODELS: [&str; 4] = [
    "claude-fable-5-1",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-sonnet-5-5",
];

/// Thinking shares this budget with the answer, hence the room.
const MAX_TOKENS: u32 = 16_000;
/// A commit message takes seconds; a model that thinks hard, a minute or two.
const TIMEOUT: Duration = Duration::from_secs(180);

/// OpenAI lists every model of the account; these words mark the ones that do
/// not answer chat requests.
const NOT_CHAT: [&str; 13] = [
    "embedding",
    "whisper",
    "tts",
    "dall-e",
    "image",
    "audio",
    "realtime",
    "moderation",
    "transcribe",
    "davinci",
    "babbage",
    "sora",
    "search",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    /// Anthropic's API, with a key.
    Anthropic,
    /// OpenAI's API, with a key.
    OpenAi,
    /// The `claude` program installed on the machine, with its own sign-in.
    ClaudeCode,
    /// The `codex` program installed on the machine, with its own sign-in.
    Codex,
}

impl Provider {
    pub const ALL: [Self; 4] = [Self::Anthropic, Self::OpenAi, Self::ClaudeCode, Self::Codex];

    pub fn label(self) -> &'static str {
        match self {
            Self::Anthropic => "Anthropic",
            Self::OpenAi => "OpenAI",
            Self::ClaudeCode => "Claude Code",
            Self::Codex => "Codex",
        }
    }

    /// The program to run for a provider that is one, see [`crate::cli`].
    pub fn program(self) -> Option<&'static str> {
        match self {
            Self::ClaudeCode => Some("claude"),
            Self::Codex => Some("codex"),
            Self::Anthropic | Self::OpenAi => None,
        }
    }

    /// Where the API lives, which also names its key in the keychain; `None`
    /// for a program, which has neither.
    pub(crate) fn host(self) -> Option<&'static str> {
        match self {
            Self::Anthropic => Some("api.anthropic.com"),
            Self::OpenAi => Some("api.openai.com"),
            Self::ClaudeCode | Self::Codex => None,
        }
    }
}

/// A model the user can pick.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct AiModel {
    /// What the API calls it, such as `claude-opus-5-5`.
    pub id: String,
    /// What people call it; the id again when the provider gives no name.
    pub name: String,
}

fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent("open-git")
        .timeout(TIMEOUT)
        .build()?)
}

fn authorized(
    provider: Provider,
    request: reqwest::RequestBuilder,
    key: &str,
) -> reqwest::RequestBuilder {
    match provider {
        Provider::Anthropic => request
            .header("x-api-key", key)
            .header("anthropic-version", ANTHROPIC_VERSION),
        Provider::OpenAi => request.bearer_auth(key),
        // A program signs in by itself; nothing is requested on its behalf.
        Provider::ClaudeCode | Provider::Codex => request,
    }
}

/// Sends `request` and returns the JSON of a successful answer.
async fn send(provider: Provider, request: reqwest::RequestBuilder) -> Result<Value> {
    let response = request.send().await?;
    let status = response.status();
    let body = response.text().await?;
    if !status.is_success() {
        return Err(Error::Api {
            provider: provider.label(),
            status: status.as_u16(),
            message: api_message(&body),
        });
    }
    serde_json::from_str(&body).map_err(|_| Error::NoAnswer(provider.label()))
}

/// Both providers explain a failure as `{"error": {"message": …}}`.
fn api_message(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|json| json["error"]["message"].as_str().map(str::to_owned))
        .unwrap_or_else(|| body.trim().chars().take(300).collect())
}

/// The models `key` can use, newest first. Also how a key is checked.
pub async fn list_models(provider: Provider, key: &str) -> Result<Vec<AiModel>> {
    let (url, read): (String, fn(&Value) -> Vec<AiModel>) = match provider {
        Provider::Anthropic => (
            format!("{ANTHROPIC_API}/models?limit=1000"),
            anthropic_models,
        ),
        Provider::OpenAi => (format!("{OPENAI_API}/models"), openai_models),
        Provider::ClaudeCode | Provider::Codex => return Err(Error::Keyless(provider.label())),
    };
    let listing = send(provider, authorized(provider, client()?.get(url), key)).await?;
    Ok(read(&listing))
}

fn anthropic_models(listing: &Value) -> Vec<AiModel> {
    let models = listing["data"].as_array().into_iter().flatten();
    models
        .filter_map(|model| {
            let id = model["id"].as_str()?;
            Some(AiModel {
                id: id.to_owned(),
                name: model["display_name"].as_str().unwrap_or(id).to_owned(),
            })
        })
        .collect()
}

fn openai_models(listing: &Value) -> Vec<AiModel> {
    let models = listing["data"].as_array().into_iter().flatten();
    let mut chat: Vec<(i64, &str)> = models
        .filter_map(|model| {
            Some((
                model["created"].as_i64().unwrap_or(0),
                model["id"].as_str()?,
            ))
        })
        .filter(|(_, id)| !NOT_CHAT.iter().any(|word| id.contains(word)))
        .collect();
    chat.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(b.1)));
    chat.into_iter()
        .map(|(_, id)| AiModel {
            id: id.to_owned(),
            name: id.to_owned(),
        })
        .collect()
}

/// Asks `model` to answer `user` under the instructions of `system`.
pub async fn complete(
    provider: Provider,
    key: &str,
    model: &str,
    system: &str,
    user: &str,
) -> Result<String> {
    let client = client()?;
    match provider {
        Provider::Anthropic => {
            let low_effort = anthropic_supports_low_effort(&client, key, model).await;
            let mut request = client.post(format!("{ANTHROPIC_API}/messages"));
            if FALLBACK_MODELS.contains(&model) {
                request = request.header("anthropic-beta", FALLBACK_BETA);
            }
            let body = anthropic_request(model, system, user, low_effort);
            let answer = send(provider, authorized(provider, request, key).json(&body)).await?;
            anthropic_answer(&answer)
        }
        Provider::OpenAi => {
            let request = client.post(format!("{OPENAI_API}/chat/completions"));
            let body = openai_request(model, system, user);
            let answer = send(provider, authorized(provider, request, key).json(&body)).await?;
            openai_answer(&answer)
        }
        Provider::ClaudeCode | Provider::Codex => Err(Error::Keyless(provider.label())),
    }
}

/// Whether `model` takes `effort: "low"`; older models reject the parameter.
/// Unknown (the lookup failed) counts as no: the request then runs at the
/// model's default effort, which always works.
async fn anthropic_supports_low_effort(client: &reqwest::Client, key: &str, model: &str) -> bool {
    let request = client.get(format!("{ANTHROPIC_API}/models/{model}"));
    match send(
        Provider::Anthropic,
        authorized(Provider::Anthropic, request, key),
    )
    .await
    {
        Ok(described) => supports_low_effort(&described),
        Err(_) => false,
    }
}

fn supports_low_effort(described: &Value) -> bool {
    described
        .pointer("/capabilities/effort/low/supported")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn anthropic_request(model: &str, system: &str, user: &str, low_effort: bool) -> Value {
    let mut body = json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": system,
        "messages": [{ "role": "user", "content": user }],
    });
    if low_effort {
        // Reading a diff and summing it up needs little deliberation; low
        // effort answers faster and costs less.
        body["output_config"] = json!({ "effort": "low" });
    }
    if FALLBACK_MODELS.contains(&model) {
        body["fallbacks"] = json!("default");
    }
    body
}

fn anthropic_answer(answer: &Value) -> Result<String> {
    let provider = Provider::Anthropic.label();
    // A refusal comes back as a success: the stop reason tells, not the status.
    match answer["stop_reason"].as_str() {
        Some("refusal") => return Err(Error::Refused(provider)),
        Some("max_tokens") => return Err(Error::CutOff(provider)),
        _ => {}
    }
    // Thinking blocks come first; only the text ones hold the message.
    let blocks = answer["content"].as_array().into_iter().flatten();
    let text: String = blocks
        .filter(|block| block["type"] == "text")
        .filter_map(|block| block["text"].as_str())
        .collect();
    if text.trim().is_empty() {
        return Err(Error::NoAnswer(provider));
    }
    Ok(text)
}

fn openai_request(model: &str, system: &str, user: &str) -> Value {
    json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
    })
}

fn openai_answer(answer: &Value) -> Result<String> {
    let provider = Provider::OpenAi.label();
    let choice = &answer["choices"][0];
    if choice["finish_reason"] == "content_filter" || choice["message"]["refusal"].is_string() {
        return Err(Error::Refused(provider));
    }
    if choice["finish_reason"] == "length" {
        return Err(Error::CutOff(provider));
    }
    match choice["message"]["content"].as_str() {
        Some(text) if !text.trim().is_empty() => Ok(text.to_owned()),
        _ => Err(Error::NoAnswer(provider)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn providers_are_named_in_lowercase_for_the_frontend() {
        assert_eq!(
            serde_json::to_string(&Provider::OpenAi).unwrap(),
            "\"openai\""
        );
        let parsed: Provider = serde_json::from_str("\"anthropic\"").unwrap();
        assert_eq!(parsed, Provider::Anthropic);
        assert_eq!(
            serde_json::to_string(&Provider::ClaudeCode).unwrap(),
            "\"claudecode\""
        );
        // A key for the APIs, a program for the others, never both.
        for provider in Provider::ALL {
            assert_ne!(provider.host().is_some(), provider.program().is_some());
        }
    }

    #[test]
    fn anthropic_requests_ask_for_low_effort_and_fallbacks_only_where_supported() {
        let current = anthropic_request("claude-opus-5-5", "system", "user", true);
        assert_eq!(current["output_config"]["effort"], "low");
        assert_eq!(current["fallbacks"], "default");
        assert_eq!(current["messages"][0]["content"], "user");

        let older = anthropic_request("claude-haiku-4-5", "system", "user", false);
        assert!(older.get("output_config").is_none());
        assert!(older.get("fallbacks").is_none());
    }

    #[test]
    fn low_effort_is_read_from_the_capabilities_of_a_model() {
        let described = json!({
            "id": "claude-opus-5-5",
            "capabilities": { "effort": { "supported": true, "low": { "supported": true } } },
        });
        assert!(supports_low_effort(&described));
        assert!(!supports_low_effort(&json!({ "id": "claude-haiku-4-5" })));
    }

    #[test]
    fn anthropic_answers_keep_the_text_and_skip_the_thinking() {
        let answer = json!({
            "stop_reason": "end_turn",
            "content": [
                { "type": "thinking", "thinking": "" },
                { "type": "text", "text": "Fix the parser\n" },
            ],
        });
        assert_eq!(anthropic_answer(&answer).unwrap(), "Fix the parser\n");

        let refused = json!({ "stop_reason": "refusal", "content": [] });
        assert!(matches!(anthropic_answer(&refused), Err(Error::Refused(_))));
        let cut = json!({ "stop_reason": "max_tokens", "content": [] });
        assert!(matches!(anthropic_answer(&cut), Err(Error::CutOff(_))));
        let empty = json!({ "stop_reason": "end_turn", "content": [] });
        assert!(matches!(anthropic_answer(&empty), Err(Error::NoAnswer(_))));
    }

    #[test]
    fn openai_answers_are_read_from_the_first_choice() {
        let answer = json!({
            "choices": [{ "finish_reason": "stop", "message": { "content": "Fix the parser" } }],
        });
        assert_eq!(openai_answer(&answer).unwrap(), "Fix the parser");

        let refused = json!({
            "choices": [{ "finish_reason": "stop", "message": { "content": null, "refusal": "No." } }],
        });
        assert!(matches!(openai_answer(&refused), Err(Error::Refused(_))));
        let cut = json!({
            "choices": [{ "finish_reason": "length", "message": { "content": "Fix the" } }],
        });
        assert!(matches!(openai_answer(&cut), Err(Error::CutOff(_))));
    }

    #[test]
    fn model_lists_keep_what_can_write_a_message() {
        let anthropic = json!({
            "data": [
                { "id": "claude-opus-5-5", "display_name": "Claude Opus 5.5" },
                { "id": "claude-haiku-5-5" },
            ],
        });
        let models = anthropic_models(&anthropic);
        assert_eq!(models[0].name, "Claude Opus 5.5");
        assert_eq!(models[1].name, "claude-haiku-5-5");

        let openai = json!({
            "data": [
                { "id": "text-embedding-3-small", "created": 30 },
                { "id": "gpt-old", "created": 10 },
                { "id": "gpt-new", "created": 20 },
                { "id": "gpt-new-audio-preview", "created": 25 },
            ],
        });
        let ids: Vec<String> = openai_models(&openai)
            .into_iter()
            .map(|model| model.id)
            .collect();
        assert_eq!(ids, ["gpt-new", "gpt-old"]);
    }

    #[test]
    fn api_errors_show_the_message_of_the_provider() {
        let body = r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#;
        assert_eq!(api_message(body), "invalid x-api-key");
        assert_eq!(api_message("  Bad gateway  "), "Bad gateway");
    }
}
