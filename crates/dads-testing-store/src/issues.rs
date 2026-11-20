//! What a store run reports about itself.
//!
//! A run returns the most usable graph it can and says what it could not do, rather than failing
//! the caller outright. Snapshot bookkeeping is therefore informational; only a failed index,
//! patch, or persist is an error.

use crate::{SnapshotAction, StoredGraph};

#[derive(Debug, Clone)]
pub struct StoreIssue {
    pub code: String,
    pub message: String,
    pub severity: StoreIssueSeverity,
}

/// Snapshot bookkeeping is informational; only a failed index, patch, or persist is an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreIssueSeverity {
    Info,
    Error,
}

/// An informational record: the run did what it set out to do.
pub(crate) fn issue(code: impl Into<String>, message: impl Into<String>) -> StoreIssue {
    StoreIssue {
        code: code.into(),
        message: message.into(),
        severity: StoreIssueSeverity::Info,
    }
}

/// An error record: an index, a patch, or a persist did not happen.
pub(crate) fn failure(code: impl Into<String>, message: impl Into<String>) -> StoreIssue {
    StoreIssue {
        code: code.into(),
        message: message.into(),
        severity: StoreIssueSeverity::Error,
    }
}

/// No graph at all, and the reason why.
pub(crate) fn fallback(code: impl Into<String>, message: impl Into<String>) -> StoredGraph {
    fallback_with(failure(code, message))
}

/// The same fallback, for a failure that has already been recorded.
pub(crate) fn fallback_with(issue: StoreIssue) -> StoredGraph {
    StoredGraph {
        graph: None,
        action: SnapshotAction::Fallback,
        issues: vec![issue],
    }
}
