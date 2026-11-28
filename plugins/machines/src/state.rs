//! Probe-metadata cache for `rebuildup.machines` (#161, ADR-0028 §3).
//! Rust port of `plugins/machines/src/state.ts`.
//!
//! Stores only last-probe metadata per machine id — timestamps,
//! reachability, remote version/protocol, plugin surface. Never
//! credential-adjacent. Single JSON document under the plugin state dir
//! (`HERDR_PLUGIN_STATE_DIR`, platform state dir fallback for external
//! clients); writes serialized through an exclusive lock file and
//! committed via tmp+rename (same discipline as rebuildup.inbox).

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime};

use hoxay_herdr_client::dirs::plugin_dirs;
use serde_json::{Map, Value};

use crate::model::{MachineProbe, PLUGIN_ID, STATE_SCHEMA_VERSION};

const LOCK_STALE_MS: u128 = 30_000;
const LOCK_TIMEOUT_MS: u128 = 10_000;
const LOCK_RETRY_MS: u64 = 25;

#[derive(Debug, Default)]
pub struct MachinesState {
    /// Last probe result per machine id (raw JSON values — the TS state
    /// stores the MachineProbe objects verbatim; keeping them as Values
    /// preserves unknown-field tolerance on read).
    pub probes: Map<String, Value>,
}

pub fn state_file_path() -> PathBuf {
    plugin_dirs(PLUGIN_ID, None, None)
        .state_dir
        .join("state.json")
}

fn lock_path() -> PathBuf {
    let mut p = state_file_path().into_os_string();
    p.push(".lock");
    PathBuf::from(p)
}

fn empty_state() -> MachinesState {
    MachinesState { probes: Map::new() }
}

/// Read the state document. Missing file → empty; wrong schema version
/// or malformed `probes` → empty (deterministic expiry semantics);
/// unparseable JSON propagates as an error, matching the TS `JSON.parse`
/// throw.
pub fn load_state() -> Result<MachinesState, String> {
    let path = state_file_path();
    let raw = match fs::read_to_string(&path) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(empty_state()),
        Err(e) => return Err(e.to_string()),
    };
    let parsed: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let obj = parsed.as_object();
    let version_ok =
        obj.and_then(|o| o.get("version")).and_then(|v| v.as_u64()) == Some(STATE_SCHEMA_VERSION);
    let probes_ok = obj
        .and_then(|o| o.get("probes"))
        .map(|v| v.is_object())
        .unwrap_or(false);
    if !version_ok || !probes_ok {
        return Ok(empty_state());
    }
    Ok(MachinesState {
        probes: obj
            .and_then(|o| o.get("probes"))
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default(),
    })
}

fn file_age_ms(path: &PathBuf) -> Option<u128> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let age = SystemTime::now().duration_since(modified).ok()?;
    Some(age.as_millis())
}

/// Exclusive-create lock file; stale (>30s) locks are removed and
/// retried; gives up after 10s. Returns a guard that removes the lock
/// on drop.
struct StateLock {
    path: PathBuf,
}

impl StateLock {
    fn acquire() -> Result<StateLock, String> {
        let file = lock_path();
        if let Some(dir) = file.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let deadline = Instant::now() + Duration::from_millis(LOCK_TIMEOUT_MS as u64);
        loop {
            match OpenOptions::new().write(true).create_new(true).open(&file) {
                Ok(mut handle) => {
                    let body = serde_json::json!({
                        "pid": std::process::id(),
                        "at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    });
                    let _ = handle.write_all(body.to_string().as_bytes());
                    return Ok(StateLock { path: file });
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    if let Some(age) = file_age_ms(&file) {
                        if age > LOCK_STALE_MS {
                            let _ = fs::remove_file(&file);
                            continue;
                        }
                    } else {
                        // stat raced a release; retry immediately.
                        continue;
                    }
                    if Instant::now() > deadline {
                        return Err(
                            "machines state lock timed out; another command may be running"
                                .to_string(),
                        );
                    }
                    std::thread::sleep(Duration::from_millis(LOCK_RETRY_MS));
                }
                Err(e) => return Err(e.to_string()),
            }
        }
    }
}

impl Drop for StateLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

/// Read-modify-write under the exclusive lock; the state document is
/// committed via tmp+rename (same discipline as the TS implementation).
pub fn update_state<F, T>(mutate: F) -> Result<T, String>
where
    F: FnOnce(&mut MachinesState) -> T,
{
    let _lock = StateLock::acquire()?;
    let mut state = load_state()?;
    let result = mutate(&mut state);
    let path = state_file_path();
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut doc = Map::new();
    doc.insert(
        "version".to_string(),
        serde_json::json!(STATE_SCHEMA_VERSION),
    );
    doc.insert("probes".to_string(), Value::Object(state.probes.clone()));
    let tmp = {
        let mut p = path.clone().into_os_string();
        p.push(format!(".tmp-{}", std::process::id()));
        PathBuf::from(p)
    };
    let body = serde_json::to_string_pretty(&Value::Object(doc)).map_err(|e| e.to_string())?;
    fs::write(&tmp, format!("{body}\n")).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(result)
}

/// Record (or overwrite) the last probe result for a machine id.
pub fn record_probe(probe: &MachineProbe) -> Result<(), String> {
    let value = serde_json::to_value(probe).map_err(|e| e.to_string())?;
    let machine_id = probe.machine_id.clone();
    update_state(|state| {
        state.probes.insert(machine_id.clone(), value);
    })
}
