//! The wire contract, held by a committed response rather than by an assertion per field.
//!
//! The golden is a *subset* of the live response: adding a key is an additive change and passes,
//! while renaming, dropping, or re-valuing a recorded key fails. The version constants are held
//! from below, so a bump is allowed and a silent downgrade is not.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::too_many_lines
)]

use dads_testing_core::{NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION, execute_request};
use serde_json::Value;
use std::path::{Path, PathBuf};

const GOLDEN: &str = include_str!("wire-golden/plan-response.json");

#[test]
fn the_live_plan_response_still_carries_every_key_the_golden_records() {
    let recorded = golden();
    assert_subset(&recorded["response"], &live_plan_response(), "response");
}

#[test]
fn the_protocol_schema_version_never_falls_below_the_recorded_floor() {
    let recorded = golden();
    let floor = recorded["versions"]["protocolSchemaVersion"]
        .as_u64()
        .expect("the golden must record protocolSchemaVersion as a number");
    assert!(
        u64::from(PROTOCOL_SCHEMA_VERSION) >= floor,
        "PROTOCOL_SCHEMA_VERSION is {PROTOCOL_SCHEMA_VERSION}, below the recorded floor {floor}"
    );
}

fn golden() -> Value {
    serde_json::from_str(GOLDEN).expect("the wire golden must be valid JSON")
}

/// The `all` operation is used deliberately: it needs no Git base, so the golden holds the wire
/// shape and not the state of whatever branch happens to be checked out.
fn live_plan_response() -> Value {
    let response = execute_request(NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Plan,
        workspace_root: fixture_root().to_string_lossy().into_owned(),
        manifest_path: None,
        base: None,
        head: None,
        all: true,
        task_ids: Vec::new(),
        jobs: None,
        cache: false,
    });
    serde_json::to_value(&response).expect("the response must serialize")
}

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/testing")
        .canonicalize()
        .expect("the fixture workspace must exist at fixtures/testing")
}

fn assert_subset(expected: &Value, actual: &Value, path: &str) {
    match expected {
        Value::Object(recorded) => {
            let live = actual
                .as_object()
                .unwrap_or_else(|| panic!("{path} is no longer an object: {actual}"));
            for (key, value) in recorded {
                let found = live
                    .get(key)
                    .unwrap_or_else(|| panic!("{path}.{key} is missing from the live response"));
                assert_subset(value, found, &format!("{path}.{key}"));
            }
        }
        Value::Array(recorded) => {
            let live = actual
                .as_array()
                .unwrap_or_else(|| panic!("{path} is no longer an array: {actual}"));
            for (index, item) in recorded.iter().enumerate() {
                assert!(
                    live.iter().any(|candidate| is_subset(item, candidate)),
                    "{path}[{index}] is not in the live response: recorded {item}"
                );
            }
        }
        _ => assert_eq!(expected, actual, "{path} changed value"),
    }
}

/// Order is not part of the contract, so array elements are matched rather than zipped. This is
/// the silent form of `assert_subset`, used to ask whether one live element answers one record.
fn is_subset(expected: &Value, actual: &Value) -> bool {
    match expected {
        Value::Object(recorded) => actual.as_object().is_some_and(|live| {
            recorded
                .iter()
                .all(|(key, value)| live.get(key).is_some_and(|found| is_subset(value, found)))
        }),
        Value::Array(recorded) => actual.as_array().is_some_and(|live| {
            recorded
                .iter()
                .all(|item| live.iter().any(|candidate| is_subset(item, candidate)))
        }),
        _ => expected == actual,
    }
}
