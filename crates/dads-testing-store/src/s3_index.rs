//! Per-run S3 prefix key index built via `aws s3api list-objects-v2`.
//!
//! Avoids spawning hundreds of `aws s3 cp` subprocesses on cold cache misses by fetching the set
//! of existing receipt keys under the configured prefix once per run. Fails open to direct `s3 cp`
//! lookups if listing fails or exceeds the page bound, so an incomplete index never drops a hit.

use serde::Deserialize;
use std::collections::HashSet;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

const MAX_LIST_PAGES: usize = 100;
const MAX_LIST_DURATION: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Default)]
pub(crate) struct S3KeyIndex {
    fetch_lock: Arc<Mutex<()>>,
    state: Arc<RwLock<Option<Option<HashSet<String>>>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ListObjectsResponse {
    #[serde(default)]
    contents: Vec<ListedObject>,
    #[serde(default)]
    is_truncated: bool,
    #[serde(default)]
    next_continuation_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ListedObject {
    key: String,
}

impl S3KeyIndex {
    pub(crate) fn clear(&self) {
        if let Ok(mut guard) = self.state.write() {
            *guard = None;
        }
    }

    pub(crate) fn insert_uploaded(&self, bucket_key: String) {
        if let Ok(mut guard) = self.state.write()
            && let Some(Some(keys)) = guard.as_mut()
        {
            keys.insert(bucket_key);
        }
    }

    /// Returns `Some(false)` when the index was built completely and proves `bucket_key` does not
    /// exist; returns `Some(true)` when it exists; returns `None` when the index is unavailable
    /// (caller should fall back to a direct `s3 cp` lookup).
    pub(crate) fn contains_or_load(
        &self,
        bucket: &str,
        prefix: &str,
        bucket_key: &str,
        aws_command: fn() -> Command,
    ) -> Option<bool> {
        if let Ok(guard) = self.state.read()
            && let Some(loaded) = guard.as_ref()
        {
            return loaded.as_ref().map(|keys| keys.contains(bucket_key));
        }
        let _single_flight = self.fetch_lock.lock();
        if let Ok(guard) = self.state.read()
            && let Some(loaded) = guard.as_ref()
        {
            return loaded.as_ref().map(|keys| keys.contains(bucket_key));
        }
        let fetched = list_prefix_keys(bucket, prefix, aws_command);
        let result = fetched.as_ref().map(|keys| keys.contains(bucket_key));
        if let Ok(mut guard) = self.state.write() {
            *guard = Some(fetched);
        }
        result
    }
}

fn list_prefix_keys(
    bucket: &str,
    prefix: &str,
    aws_command: fn() -> Command,
) -> Option<HashSet<String>> {
    let list_prefix = if prefix.is_empty() {
        String::new()
    } else {
        format!("{prefix}/")
    };
    let mut keys = HashSet::new();
    let mut continuation: Option<String> = None;
    let started = Instant::now();

    for _ in 0..MAX_LIST_PAGES {
        if started.elapsed() > MAX_LIST_DURATION {
            return None;
        }
        let mut command = aws_command();
        command
            .args([
                "s3api",
                "list-objects-v2",
                "--bucket",
                bucket,
                "--max-keys",
                "1000",
                "--output",
                "json",
                "--cli-read-timeout",
                "5",
                "--cli-connect-timeout",
                "3",
            ])
            .stdin(Stdio::null())
            .stderr(Stdio::null());
        if !list_prefix.is_empty() {
            command.args(["--prefix", &list_prefix]);
        }
        if let Some(token) = continuation.as_deref() {
            command.args(["--continuation-token", token]);
        }
        let output = command.output().ok()?;
        if !output.status.success() {
            return None;
        }
        let page: ListObjectsResponse = serde_json::from_slice(&output.stdout).ok()?;
        for object in page.contents {
            keys.insert(object.key);
        }
        if !page.is_truncated {
            return Some(keys);
        }
        continuation = page.next_continuation_token;
        continuation.as_ref()?;
    }
    None
}
