//! Persistent artifact registry state for rebuildup.artifacts.
//!
//! Rust port of `plugins/artifacts/src/state.ts`. Stored under the plugin
//! state dir (`HERDR_PLUGIN_STATE_DIR`, falling back to the platform
//! state dir for external clients):
//!
//!   state.json            — the artifact index (one JSON document)
//!   artifacts/<id>/       — `state_copy` payload bytes
//!
//! Writes are serialized through an exclusive lock file and committed
//! via tmp+rename so concurrent CLI invocations cannot corrupt or
//! interleave state — same discipline as plugins/handoff,
//! plugins/checkpoints, and plugins/inbox (AGENTS §4). Payload copies
//! are written to a tmp name inside the artifact dir and renamed into
//! place.
//!
//! Records that fail `parse_artifact_record` are quarantined into
//! `state.corrupt` (id list) so reads can report them honestly instead
//! of failing the whole index or silently succeeding.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use hoxay_herdr_client::dirs::plugin_dirs;
use serde_json::Value;

use crate::model::{
    parse_artifact_record, valid_artifact_id, ArtifactRecord, PLUGIN_ID, STATE_SCHEMA_VERSION,
};

const LOCK_STALE_MS: u64 = 30_000;
const LOCK_TIMEOUT_MS: u64 = 10_000;
const LOCK_RETRY_MS: u64 = 25;

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct ArtifactsState {
    pub version: u64,
    /// Index records keyed by artifact_id. BTreeMap keeps a deterministic
    /// order; the TS writer preserves insertion order, which only matters
    /// for exact `created_at` ties in list ordering (documented in
    /// docs/research/artifacts-native-rust.md).
    pub artifacts: BTreeMap<String, ArtifactRecord>,
    /// Ids whose persisted record failed parsing (reported, never hidden).
    pub corrupt: Vec<String>,
}

pub fn empty_state() -> ArtifactsState {
    ArtifactsState {
        version: STATE_SCHEMA_VERSION,
        artifacts: BTreeMap::new(),
        corrupt: Vec::new(),
    }
}

pub fn state_file_path() -> PathBuf {
    plugin_dirs(PLUGIN_ID, None, None)
        .state_dir
        .join("state.json")
}

/// Root of the `state_copy` payload tree: `<stateDir>/artifacts/`.
pub fn artifacts_root() -> PathBuf {
    plugin_dirs(PLUGIN_ID, None, None)
        .state_dir
        .join("artifacts")
}

/// Directory for one artifact's payload. Callers MUST have validated
/// `artifact_id` against the contract pattern first — the pattern admits
/// no separators, so the result can never escape `artifacts_root()`.
pub fn artifact_dir(artifact_id: &str) -> Result<PathBuf, String> {
    if !valid_artifact_id(artifact_id) {
        return Err(format!("refusing unsafe artifact_id: {}", artifact_id));
    }
    Ok(artifacts_root().join(artifact_id))
}

fn lock_path() -> PathBuf {
    let mut p = state_file_path().into_os_string();
    p.push(".lock");
    PathBuf::from(p)
}

// ---------------------------------------------------------------------------
// Load / update
// ---------------------------------------------------------------------------

/// Read the index. Missing file → empty state; malformed JSON or wrong
/// schema version → empty state (same as TS `loadState`); individual
/// bad records → `corrupt` quarantine list.
pub fn load_state() -> Result<ArtifactsState, String> {
    let raw = match fs::read_to_string(state_file_path()) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(empty_state()),
        Err(e) => return Err(format!("cannot read state file: {}", e)),
    };
    let parsed: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        // TS `JSON.parse` throws here and loadState rethrows (only ENOENT
        // yields empty state) — a corrupt index file is a hard error,
        // never silently treated as empty.
        Err(e) => return Err(format!("cannot parse state file: {}", e)),
    };
    let version_ok = parsed
        .get("version")
        .and_then(|v| v.as_f64())
        .map(|v| v == STATE_SCHEMA_VERSION as f64)
        .unwrap_or(false);
    let artifacts_val = parsed.get("artifacts");
    let artifacts_obj_ok = artifacts_val.map(|v| v.is_object()).unwrap_or(false);
    if !version_ok || !artifacts_obj_ok {
        return Ok(empty_state());
    }
    let mut state = empty_state();
    if let Some(map) = artifacts_val.and_then(|v| v.as_object()) {
        for (id, value) in map {
            match parse_artifact_record(value) {
                Some(record) if record.artifact_id == *id => {
                    state.artifacts.insert(id.clone(), record);
                }
                _ => state.corrupt.push(id.clone()),
            }
        }
    }
    Ok(state)
}

fn acquire_lock() -> Result<Box<dyn FnOnce() + Send>, String> {
    let file = lock_path();
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create state dir {}: {}", parent.display(), e))?;
    }
    let deadline = now_millis() + LOCK_TIMEOUT_MS;
    loop {
        // O_EXCL create — mirrors `open(file, "wx")`.
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&file)
        {
            Ok(mut handle) => {
                let body = serde_json::json!({
                    "pid": std::process::id(),
                    "at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                });
                let _ = handle.write_all(body.to_string().as_bytes());
                let _ = handle.sync_all();
                drop(handle);
                return Ok(Box::new(move || {
                    let _ = fs::remove_file(&file);
                }));
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                // Stale lock (>30s) is removed and retried.
                match fs::metadata(&file) {
                    Ok(meta) => {
                        let age = meta
                            .modified()
                            .ok()
                            .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
                            .map(|d| now_millis().saturating_sub(d.as_millis() as u64))
                            .unwrap_or(0);
                        if age > LOCK_STALE_MS {
                            let _ = fs::remove_file(&file);
                            continue;
                        }
                    }
                    Err(_) => continue,
                }
                if now_millis() > deadline {
                    return Err(
                        "artifacts state lock timed out; another command may be running"
                            .to_string(),
                    );
                }
                std::thread::sleep(Duration::from_millis(LOCK_RETRY_MS));
            }
            Err(e) => return Err(format!("cannot acquire state lock: {}", e)),
        }
    }
}

fn state_to_json(state: &ArtifactsState) -> Value {
    // `artifacts` is a JSON object keyed by id; `corrupt` is a string list.
    let mut artifacts = serde_json::Map::new();
    for (id, record) in &state.artifacts {
        artifacts.insert(
            id.clone(),
            serde_json::to_value(record).unwrap_or(Value::Null),
        );
    }
    serde_json::json!({
        "version": state.version,
        "artifacts": Value::Object(artifacts),
        "corrupt": state.corrupt,
    })
}

/// Read-modify-write under the exclusive lock; mutations must be
/// synchronous (the closure may fail with a domain error — nothing is
/// persisted then, matching the TS `updateState` contract).
pub fn update_state<T, F, E>(mutate: F) -> Result<T, E>
where
    F: FnOnce(&mut ArtifactsState) -> Result<T, E>,
    E: From<String>,
{
    let release = acquire_lock().map_err(E::from)?;
    let result = (|| -> Result<T, E> {
        let mut state = load_state().map_err(E::from)?;
        let out = mutate(&mut state)?;
        if let Some(parent) = state_file_path().parent() {
            fs::create_dir_all(parent).map_err(|e| {
                E::from(format!(
                    "cannot create state dir {}: {}",
                    parent.display(),
                    e
                ))
            })?;
        }
        let tmp = format!("{}.tmp-{}", state_file_path().display(), std::process::id());
        let body = format!(
            "{}\n",
            serde_json::to_string_pretty(&state_to_json(&state)).unwrap_or_default()
        );
        fs::write(Path::new(&tmp), body).map_err(|e| E::from(format!("cannot write state: {}", e)))?;
        fs::rename(&tmp, state_file_path())
            .map_err(|e| E::from(format!("cannot commit state: {}", e)))?;
        Ok(out)
    })();
    release();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_dir_rejects_unsafe_ids() {
        assert!(artifact_dir("../escape").is_err());
        assert!(artifact_dir("art-ok_1-2").is_ok());
    }

    #[test]
    fn load_missing_state_is_empty() {
        // No HERDR_PLUGIN_STATE_DIR in unit tests → derived path may not
        // exist; whatever it resolves to, a missing file yields empty.
        let state = load_state().expect("load");
        assert_eq!(state.version, STATE_SCHEMA_VERSION);
    }
}
