//! Artifact registry core for rebuildup.artifacts (contract
//! `herdr-plugins.artifacts/v1`, T2 #141).
//!
//! Rust port of `plugins/artifacts/src/registry.ts`. Owns: register
//! (state_copy default / opt-in path_ref), list, get, search, delete —
//! plus the boundary checks the contract fixes: artifact_id-only
//! retrieval (traversal guard), per-kind size caps for state_copy,
//! oversize-as-warning for path_ref, leading-byte MIME sniffing with
//! html shape refusal, sha256 integrity, host/session/owner identity
//! fields, and deterministic read-time resolution of index/payload
//! inconsistency (missing_ref, owner_stale, orphans, corrupt records —
//! reported, never success). T3 adds `verify`; T4 adds `deliver`/`gc`.
//!
//! The plugin never executes or renders artifact content (ADR-0024 §4).

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use hoxay_herdr_client::commands::{session_snapshot, CallOptions, CommandError};
use hoxay_herdr_client::snapshot::SessionSnapshot;
use hoxay_herdr_client::socket::{request, ClientError};
use hoxay_herdr_client::target::{resolve_socket_path, ResolveTargetOptions};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::model::{
    self, detect_kind, ext_mime_for, file_ext, is_html_file_name, js_date_parse_ms, max_bytes,
    sanitize_filename, sniff_mime, valid_artifact_id, ArtifactMeta, ArtifactOwner, ArtifactRecord,
    ArtifactRenderMeta, ArtifactStorage, ARTIFACT_KINDS, SNIFF_BYTES,
};
use crate::state::{artifact_dir, artifacts_root, load_state, update_state, ArtifactsState};

// ---------------------------------------------------------------------------
// Errors — mirrors TS `RegistryError` plus the CLI's generic error path
// ---------------------------------------------------------------------------

/// Structured registry failure mirroring TS `RegistryError`: `code` is the
/// contract-specific code, `kind` the coarse category, `extra` merges into
/// the CLI error document.
#[derive(Debug)]
pub struct RegistryError {
    pub code: String,
    pub kind: String,
    pub message: String,
    pub extra: Option<Map<String, Value>>,
}

impl RegistryError {
    pub fn new(
        code: &str,
        kind: &str,
        message: impl Into<String>,
        extra: Option<Map<String, Value>>,
    ) -> Self {
        RegistryError {
            code: code.to_string(),
            kind: kind.to_string(),
            message: message.into(),
            extra,
        }
    }
}

/// Registry functions fail either with a structured domain error or with a
/// plain message (the TS code path where a raw `Error` propagates to the
/// CLI's generic `{code:"error"}` handler — e.g. stat/read failures after
/// realpath). The CLI maps `Plain` to exit 1 with no `kind`.
#[derive(Debug)]
pub enum RegError {
    Domain(RegistryError),
    Plain(String),
}

impl From<RegistryError> for RegError {
    fn from(e: RegistryError) -> Self {
        RegError::Domain(e)
    }
}
impl From<String> for RegError {
    fn from(m: String) -> Self {
        RegError::Plain(m)
    }
}

fn fail<E: Into<String>>(code: &str, kind: &str, message: E) -> RegError {
    RegError::Domain(RegistryError::new(code, kind, message, None))
}

fn fail_extra(
    code: &str,
    kind: &str,
    message: impl Into<String>,
    extra: Map<String, Value>,
) -> RegError {
    RegError::Domain(RegistryError::new(code, kind, message, Some(extra)))
}

fn extra_of(pairs: &[(&str, Value)]) -> Map<String, Value> {
    let mut m = Map::new();
    for (k, v) in pairs {
        m.insert(k.to_string(), v.clone());
    }
    m
}

// ---------------------------------------------------------------------------
// Hashing / sniffing IO
// ---------------------------------------------------------------------------

fn sha256_file(file_path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(file_path)
        .map_err(|e| format!("cannot open {}: {}", file_path.display(), e))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("cannot read {}: {}", file_path.display(), e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex_lower(&hasher.finalize()))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex_lower(&hasher.finalize())
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

fn read_head(file_path: &Path) -> Result<Vec<u8>, String> {
    let mut file = fs::File::open(file_path)
        .map_err(|e| format!("cannot open {}: {}", file_path.display(), e))?;
    let mut buf = vec![0u8; SNIFF_BYTES];
    let n = file
        .read(&mut buf)
        .map_err(|e| format!("cannot read {}: {}", file_path.display(), e))?;
    buf.truncate(n);
    Ok(buf)
}

fn new_artifact_id() -> String {
    let bytes: [u8; 12] = rand::random();
    let mut s = String::from("art-");
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// JS `String(number)` for sizes: integers print without a fraction.
pub fn fmt_num(v: f64) -> String {
    if v.fract() == 0.0 && v.is_finite() {
        format!("{}", v as i64)
    } else {
        format!("{}", v)
    }
}

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

pub struct RegisterOptions {
    /// Source file path; mutually exclusive with `bytes`.
    pub source_path: Option<String>,
    /// Inline bytes (stdin registration).
    pub bytes: Option<Vec<u8>>,
    /// Display/fallback filename used for kind detection and the stored name.
    pub filename: Option<String>,
    pub kind: Option<String>,
    pub storage: Option<String>,
    pub title: Option<String>,
    pub pane_id: Option<String>,
    pub agent_session: Option<String>,
    pub created_by: Option<String>,
    pub refs: Option<Vec<String>>,
    pub host: String,
    pub session: String,
}

/// Register one artifact. `state_copy` (default) copies bytes into
/// `HERDR_PLUGIN_STATE_DIR/artifacts/<id>/` under the per-kind cap;
/// `path_ref` records the resolved realpath and reports oversize as a
/// warning instead of refusing (ADR-0024 §2).
pub fn register_artifact(options: &RegisterOptions) -> Result<ArtifactRecord, RegError> {
    let storage_mode = options
        .storage
        .clone()
        .unwrap_or_else(|| "state_copy".to_string());
    let has_path = options.source_path.is_some();
    let has_bytes = options.bytes.is_some();
    if has_path == has_bytes {
        return Err(fail(
            "invalid",
            "invalid",
            "register requires exactly one of --path or --stdin",
        ));
    }

    let head: Vec<u8>;
    let size: u64;
    let sha256: String;
    let mut real_source_path: Option<String> = None;
    let mime: String;
    let mut filename = options.filename.clone();

    if let Some(bytes) = &options.bytes {
        head = bytes[..bytes.len().min(SNIFF_BYTES)].to_vec();
        size = bytes.len() as u64;
        sha256 = sha256_bytes(bytes);
        mime = sniff_mime(&head);
        if filename.is_none() {
            filename = Some("stdin".to_string());
        }
    } else {
        let source = options.source_path.clone().unwrap_or_default();
        let resolved = match fs::canonicalize(&source) {
            Ok(r) => r,
            Err(e) => {
                let not_found = matches!(
                    e.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                );
                return Err(fail_extra(
                    if not_found { "source_not_found" } else { "source_unreadable" },
                    if not_found { "not_found" } else { "unavailable" },
                    format!("cannot resolve artifact source: {}", source),
                    extra_of(&[("source", json!(source))]),
                ));
            }
        };
        // `stat`/`readHead`/`sha256File` failures propagate as plain errors
        // in TS (outside the realpath try) → generic {code:"error"} path.
        let info = fs::metadata(&resolved)
            .map_err(|e| RegError::Plain(e.to_string()))?;
        if !info.is_file() {
            return Err(fail_extra(
                "source_not_file",
                "invalid",
                format!("artifact source is not a regular file: {}", source),
                extra_of(&[("source", json!(source))]),
            ));
        }
        head = read_head(&resolved).map_err(RegError::Plain)?;
        size = info.len();
        sha256 = sha256_file(&resolved).map_err(RegError::Plain)?;
        mime = sniff_mime(&head);
        real_source_path = Some(resolved.to_string_lossy().into_owned());
        if filename.is_none() {
            filename = resolved
                .file_name()
                .map(|s| s.to_string_lossy().into_owned());
        }
    }

    let filename = filename.unwrap_or_default();
    let kind = options
        .kind
        .clone()
        .unwrap_or_else(|| detect_kind(&filename, &mime));
    if !ARTIFACT_KINDS.contains(&kind.as_str()) {
        return Err(fail_extra(
            "unsupported_kind",
            "invalid",
            format!("unsupported artifact kind: {}", kind),
            extra_of(&[("artifact_kind", json!(kind))]),
        ));
    }
    let cap = max_bytes(&kind);
    let mut warnings: Vec<String> = Vec::new();

    // Kind-specific validation (T3 #142, upstream HtmlRender/attachmentStore
    // rules, ADR-0024 §4). HTML is the only refusal kind: path sources must
    // keep a .html/.htm name on the *resolved* path and the bytes must open
    // like a document; stdin bytes are judged on content alone.
    if kind == "html" {
        if has_path {
            if let Some(rp) = &real_source_path {
                if !is_html_file_name(rp) {
                    return Err(fail_extra(
                        "invalid_html",
                        "invalid",
                        format!(
                            "kind 'html' requires a .html/.htm file name; resolved path is {}",
                            rp
                        ),
                        extra_of(&[
                            ("artifact_kind", json!(kind)),
                            ("resolved_path", json!(rp)),
                        ]),
                    ));
                }
            }
        }
        if mime != "text/html" {
            return Err(fail_extra(
                "mime_mismatch",
                "invalid",
                format!("kind 'html' requires HTML leading bytes; sniffed {}", mime),
                extra_of(&[("sniffed_mime", json!(mime)), ("artifact_kind", json!(kind))]),
            ));
        }
    } else {
        // A concrete sniffed type (not generic text/plain or
        // application/octet-stream) that disagrees with the kind family or
        // with the filename extension is reported as a structured warning —
        // never a refusal for non-html kinds (ADR-0024 §4).
        let concrete = mime != "text/plain" && mime != "application/octet-stream";
        if concrete {
            let kind_mismatch = (kind == "image"
                && mime != "image/svg+xml"
                && !mime.starts_with("image/"))
                || (kind == "pdf" && mime != "application/pdf");
            if kind_mismatch {
                warnings.push("mime_mismatch".to_string());
            }
            let ext = file_ext(&filename);
            if let Some(em) = ext_mime_for(&ext) {
                if mime != em {
                    warnings.push("extension_mime_mismatch".to_string());
                }
            }
        }
    }

    let artifact_id = new_artifact_id();
    let stored_name = sanitize_filename(if filename.is_empty() {
        "artifact"
    } else {
        &filename
    });
    let mut storage_ref: String;
    let mut resolved_path: String;
    let mut oversize = false;

    if storage_mode == "state_copy" {
        if size > cap {
            return Err(fail_extra(
                "too_large",
                "invalid",
                format!(
                    "artifact exceeds {} cap of {} bytes (got {})",
                    kind,
                    cap,
                    fmt_num(size as f64)
                ),
                extra_of(&[
                    ("artifact_kind", json!(kind)),
                    ("size", json!(size)),
                    ("max_bytes", json!(cap)),
                ]),
            ));
        }
        let dir = artifact_dir(&artifact_id)
            .map_err(|m| RegError::Plain(m))?;
        fs::create_dir_all(&dir).map_err(|e| {
            RegError::Plain(format!("cannot create artifact dir: {}", e))
        })?;
        let final_path = dir.join(&stored_name);
        let tmp_path = PathBuf::from(format!(
            "{}.tmp-{}",
            final_path.display(),
            std::process::id()
        ));
        if let Some(bytes) = &options.bytes {
            fs::write(&tmp_path, bytes).map_err(|e| {
                RegError::Plain(format!("cannot write artifact payload: {}", e))
            })?;
        } else {
            fs::copy(
                real_source_path.as_deref().unwrap_or(""),
                &tmp_path,
            )
            .map_err(|e| {
                RegError::Plain(format!("cannot copy artifact payload: {}", e))
            })?;
        }
        fs::rename(&tmp_path, &final_path).map_err(|e| {
            RegError::Plain(format!("cannot commit artifact payload: {}", e))
        })?;
        storage_ref = format!("artifacts/{}/{}", artifact_id, stored_name);
        resolved_path = final_path.to_string_lossy().into_owned();
    } else {
        // path_ref: no bytes copied; oversize is a warning, not a refusal.
        if real_source_path.is_none() {
            return Err(fail(
                "invalid",
                "invalid",
                "path_ref storage requires --path (stdin has no stable ref)",
            ));
        }
        oversize = size > cap;
        if oversize {
            warnings.push("oversize".to_string());
        }
        storage_ref = real_source_path.clone().unwrap_or_default();
        resolved_path = storage_ref.clone();
    }

    let created_by = options.created_by.clone().unwrap_or_else(|| {
        if options.agent_session.is_some() {
            "agent".to_string()
        } else if options.pane_id.is_some() {
            "pane".to_string()
        } else {
            "cli".to_string()
        }
    });
    let mut record = ArtifactRecord {
        contract: model::CONTRACT.to_string(),
        artifact_id: artifact_id.clone(),
        kind: kind.clone(),
        title: options.title.clone(),
        host: options.host.clone(),
        session: options.session.clone(),
        owner: ArtifactOwner {
            pane_id: options.pane_id.clone(),
            agent_session: options.agent_session.clone(),
            created_by,
        },
        storage: ArtifactStorage {
            mode: storage_mode.clone(),
            ref_: storage_ref,
            resolved_path,
        },
        size: size as f64,
        mime: mime.clone(),
        sha256,
        oversize,
        created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        refs: None,
        warnings: None,
        meta: None,
    };
    if let Some(refs) = &options.refs {
        if !refs.is_empty() {
            record.refs = Some(refs.clone());
        }
    }
    if !warnings.is_empty() {
        record.warnings = Some(warnings);
    }
    // HTML artifacts carry the render-isolation notice as metadata: the
    // plugin validates shape only; sandbox/CSP is a client requirement
    // (ADR-0024 §4, issue #142).
    if kind == "html" {
        record.meta = Some(ArtifactMeta {
            render: ArtifactRenderMeta {
                isolation: "required".to_string(),
                policy: "client".to_string(),
            },
        });
    }

    // Index insert under the single-writer lock; the payload copy above is
    // already durable, so a failed insert leaves a detectable orphan dir.
    let id_for_update = artifact_id.clone();
    let record_for_update = record.clone();
    update_state(|state: &mut ArtifactsState| -> Result<(), RegError> {
        if state.artifacts.contains_key(&id_for_update) {
            return Err(fail(
                "artifact_id_collision",
                "unavailable",
                format!("artifact id collision: {}", id_for_update),
            ));
        }
        state.artifacts.insert(id_for_update.clone(), record_for_update.clone());
        Ok(())
    })?;
    Ok(record)
}

// ---------------------------------------------------------------------------
// Read-time annotation
// ---------------------------------------------------------------------------

/// Absolute path a `state_copy` payload must live at for this record.
fn expected_stored_path(record: &ArtifactRecord) -> Option<PathBuf> {
    if record.storage.mode != "state_copy" {
        return None;
    }
    let name = Path::new(&record.storage.ref_)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())?;
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }
    let dir = artifact_dir(&record.artifact_id).ok()?;
    let expected = dir.join(&name);
    // Defense in depth: the recorded resolved_path must equal the path the
    // index layout dictates (artifact_dir is already traversal-safe).
    if record.storage.resolved_path != expected.to_string_lossy() {
        return None;
    }
    Some(expected)
}

/// Annotated record = the contract record plus read-time verdicts.
#[derive(Debug, Clone)]
pub struct AnnotatedArtifact {
    pub record: ArtifactRecord,
    /// Read-time integrity verdict: payload missing or unsafe.
    pub missing_ref: bool,
    /// Read-time owner staleness verdict (only when a live snapshot was consulted).
    pub owner_stale: bool,
    /// Merged warnings (register-time + read-time); always serialized,
    /// matching the TS `{...record, warnings}` spread.
    pub warnings: Vec<String>,
}

impl AnnotatedArtifact {
    /// Serialize to the contract JSON shape.
    pub fn to_json(&self) -> Value {
        let mut v = serde_json::to_value(&self.record).unwrap_or_else(|_| json!({}));
        if let Value::Object(ref mut map) = v {
            map.insert("missing_ref".to_string(), json!(self.missing_ref));
            map.insert("owner_stale".to_string(), json!(self.owner_stale));
            map.insert("warnings".to_string(), json!(self.warnings));
        }
        v
    }
}

fn annotate(record: &ArtifactRecord, live_pane_ids: Option<&BTreeSet<String>>) -> AnnotatedArtifact {
    let mut warnings: Vec<String> = record.warnings.clone().unwrap_or_default();
    let mut missing_ref = false;
    let mut oversize = record.oversize;

    if record.storage.mode == "state_copy" {
        match expected_stored_path(record) {
            None => {
                missing_ref = true;
                warnings.push("storage_ref_missing".to_string());
            }
            Some(p) => {
                // lstat semantics: symlink_metadata never follows links —
                // symlinks inside the artifacts tree are never followed.
                match fs::symlink_metadata(&p) {
                    Ok(meta) => {
                        if meta.file_type().is_symlink() || !meta.is_file() {
                            missing_ref = true;
                            warnings.push("storage_ref_missing".to_string());
                        }
                    }
                    Err(_) => {
                        missing_ref = true;
                        warnings.push("storage_ref_missing".to_string());
                    }
                }
            }
        }
    } else {
        match fs::metadata(&record.storage.resolved_path) {
            Ok(info) => {
                if !info.is_file() {
                    missing_ref = true;
                    warnings.push("storage_ref_missing".to_string());
                } else if info.len() > max_bytes(&record.kind) && !oversize {
                    oversize = true;
                    warnings.push("oversize".to_string());
                }
            }
            Err(_) => {
                missing_ref = true;
                warnings.push("storage_ref_missing".to_string());
            }
        }
    }

    let mut owner_stale = false;
    if let Some(ids) = live_pane_ids {
        if let Some(pane_id) = &record.owner.pane_id {
            if !ids.contains(pane_id) {
                owner_stale = true;
                warnings.push("owner_stale".to_string());
            }
        }
    }

    let mut rec = record.clone();
    rec.oversize = oversize;
    AnnotatedArtifact {
        record: rec,
        missing_ref,
        owner_stale,
        warnings,
    }
}

fn live_pane_id_set(snapshot: Option<&SessionSnapshot>) -> Option<BTreeSet<String>> {
    let snapshot = snapshot?;
    let mut ids = BTreeSet::new();
    for pane in &snapshot.panes {
        if !pane.pane_id.is_empty() {
            ids.insert(pane.pane_id.clone());
        }
    }
    Some(ids)
}

/// Pane ids present in the live snapshot; empty set when unreachable.
pub fn snapshot_pane_ids(snapshot: &SessionSnapshot) -> BTreeSet<String> {
    live_pane_id_set(Some(snapshot)).unwrap_or_default()
}

/// Agent session value reported for a pane, when the snapshot has one.
pub fn agent_session_for_pane(snapshot: &SessionSnapshot, pane_id: &str) -> Option<String> {
    let agent = snapshot.agent(pane_id)?;
    let session = agent.agent_session.as_ref()?;
    session.value.clone().filter(|v| !v.is_empty())
}

// ---------------------------------------------------------------------------
// list / get / search
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Clone)]
pub struct ListFilter {
    pub kind: Option<String>,
    pub pane_id: Option<String>,
    pub agent_session: Option<String>,
    pub created_by: Option<String>,
    pub session: Option<String>,
    /// `None` → default page (200); `Some(0)` → no page cap (export).
    pub limit: Option<usize>,
}

const DEFAULT_LIMIT: usize = 200;
const MAX_LISTED_ORPHANS: usize = 100;

/// Ids of payload dirs under artifacts/ with no index record.
fn orphan_ids(indexed: &BTreeSet<String>) -> Vec<String> {
    let mut orphans: Vec<String> = Vec::new();
    let entries = match fs::read_dir(artifacts_root()) {
        Ok(e) => e,
        Err(_) => return orphans,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !valid_artifact_id(&name) || indexed.contains(&name) {
            continue;
        }
        orphans.push(name);
        if orphans.len() >= MAX_LISTED_ORPHANS {
            break;
        }
    }
    orphans.sort();
    orphans
}

fn apply_filters(
    records: Vec<AnnotatedArtifact>,
    f: &ListFilter,
) -> Vec<AnnotatedArtifact> {
    records
        .into_iter()
        .filter(|r| {
            if let Some(k) = &f.kind {
                if r.record.kind != *k {
                    return false;
                }
            }
            if let Some(p) = &f.pane_id {
                if r.record.owner.pane_id.as_deref() != Some(p.as_str()) {
                    return false;
                }
            }
            if let Some(a) = &f.agent_session {
                if r.record.owner.agent_session.as_deref() != Some(a.as_str()) {
                    return false;
                }
            }
            if let Some(c) = &f.created_by {
                if r.record.owner.created_by != *c {
                    return false;
                }
            }
            if let Some(s) = &f.session {
                if r.record.session != *s {
                    return false;
                }
            }
            true
        })
        .collect()
}

fn sort_newest_first(mut records: Vec<AnnotatedArtifact>) -> Vec<AnnotatedArtifact> {
    // created_at is ISO-8601 ASCII → byte order == chronological order.
    // Rust's sort is stable; TS Array.sort is stable too (ES2019+).
    records.sort_by(|a, b| b.record.created_at.cmp(&a.record.created_at));
    records
}

fn annotate_all(
    state: &ArtifactsState,
    snapshot: Option<&SessionSnapshot>,
) -> Vec<AnnotatedArtifact> {
    let live = live_pane_id_set(snapshot);
    state
        .artifacts
        .values()
        .map(|record| annotate(record, live.as_ref()))
        .collect()
}

fn list_tail(state: &ArtifactsState) -> (Vec<String>, Vec<String>) {
    let indexed: BTreeSet<String> = state.artifacts.keys().cloned().collect();
    let mut corrupt = state.corrupt.clone();
    corrupt.sort();
    (orphan_ids(&indexed), corrupt)
}

pub struct ListResult {
    pub artifacts: Vec<AnnotatedArtifact>,
    pub total: usize,
    pub orphans: Vec<String>,
    pub corrupt: Vec<String>,
}

pub fn list_artifacts(
    options: &ListFilter,
    snapshot: Option<&SessionSnapshot>,
) -> Result<ListResult, RegError> {
    let state = load_state().map_err(|m| RegError::Plain(m))?;
    let annotated = annotate_all(&state, snapshot);
    let filtered = sort_newest_first(apply_filters(annotated, options));
    let total = filtered.len();
    let limit = options.limit.unwrap_or(DEFAULT_LIMIT);
    let page: Vec<AnnotatedArtifact> = if limit > 0 {
        filtered.into_iter().take(limit).collect()
    } else {
        filtered
    };
    let (orphans, corrupt) = list_tail(&state);
    Ok(ListResult {
        total,
        artifacts: page,
        orphans,
        corrupt,
    })
}

/// Free-text surface: identity, kind/mime, filename, owner fields, host,
/// session, and back-references — metadata only, never payload bytes
/// (issue #142: 検索は filename・metadata、content scan はしない).
fn searchable_text(record: &AnnotatedArtifact) -> String {
    let base = Path::new(&record.record.storage.ref_)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut parts: Vec<String> = vec![
        record.record.artifact_id.clone(),
        record.record.title.clone().unwrap_or_default(),
        record.record.kind.clone(),
        record.record.mime.clone(),
        record.record.session.clone(),
        record.record.host.clone(),
        base,
        record.record.owner.pane_id.clone().unwrap_or_default(),
        record.record.owner.agent_session.clone().unwrap_or_default(),
        record.record.owner.created_by.clone(),
    ];
    if let Some(refs) = &record.record.refs {
        parts.extend(refs.iter().cloned());
    }
    parts.join("\n").to_lowercase()
}

pub struct SearchOptions {
    pub filter: ListFilter,
    pub query: String,
    /// Inclusive lower bound on created_at (ISO-8601, validated by the CLI).
    pub since: Option<String>,
    /// Inclusive upper bound on created_at (ISO-8601, validated by the CLI).
    pub until: Option<String>,
}

pub struct SearchResult {
    pub artifacts: Vec<AnnotatedArtifact>,
    pub total: usize,
    pub query: String,
    pub orphans: Vec<String>,
    pub corrupt: Vec<String>,
}

pub fn search_artifacts(
    options: &SearchOptions,
    snapshot: Option<&SessionSnapshot>,
) -> Result<SearchResult, RegError> {
    let query = options.query.trim().to_lowercase();
    if query.is_empty() {
        return Err(fail("usage", "invalid", "search requires a non-empty query"));
    }
    let state = load_state().map_err(RegError::Plain)?;
    let annotated = annotate_all(&state, snapshot);
    let filtered: Vec<AnnotatedArtifact> = apply_filters(annotated, &options.filter)
        .into_iter()
        .filter(|record| {
            if !searchable_text(record).contains(&query) {
                return false;
            }
            if let Some(since) = &options.since {
                if record.record.created_at < *since {
                    return false;
                }
            }
            if let Some(until) = &options.until {
                if record.record.created_at > *until {
                    return false;
                }
            }
            true
        })
        .collect();
    let filtered = sort_newest_first(filtered);
    let total = filtered.len();
    let limit = options.filter.limit.unwrap_or(DEFAULT_LIMIT);
    let page: Vec<AnnotatedArtifact> = if limit > 0 {
        filtered.into_iter().take(limit).collect()
    } else {
        filtered
    };
    let (orphans, corrupt) = list_tail(&state);
    Ok(SearchResult {
        artifacts: page,
        total,
        query: options.query.clone(),
        orphans,
        corrupt,
    })
}

pub struct DeleteResult {
    pub artifact_id: String,
    pub storage_mode: String,
    pub removed_payload: bool,
}

/// Delete one artifact: index record plus `state_copy` payload. Records
/// carrying `refs` (handoff/conversations/checkpoint back-references)
/// require `force` — the refusal is structured (`referenced`), never a
/// silent delete. `path_ref` payloads are external files and are NEVER
/// removed by the plugin.
pub fn delete_artifact(artifact_id: &str, force: bool) -> Result<DeleteResult, RegError> {
    if !valid_artifact_id(artifact_id) {
        return Err(fail_extra(
            "artifact_not_found",
            "not_found",
            format!("unknown or malformed artifact_id: {}", artifact_id),
            extra_of(&[("artifact_id", json!(artifact_id))]),
        ));
    }
    let id = artifact_id.to_string();
    let removed = update_state(|state: &mut ArtifactsState| -> Result<ArtifactRecord, RegError> {
        let record = match state.artifacts.get(&id) {
            Some(r) => r.clone(),
            None => {
                return Err(fail_extra(
                    "artifact_not_found",
                    "not_found",
                    format!("artifact not found: {}", id),
                    extra_of(&[("artifact_id", json!(id))]),
                ));
            }
        };
        if !force {
            if let Some(refs) = &record.refs {
                if !refs.is_empty() {
                    return Err(fail_extra(
                        "referenced",
                        "warning",
                        format!(
                            "artifact {} is referenced ({} ref(s)); pass --force to delete",
                            id,
                            refs.len()
                        ),
                        extra_of(&[
                            ("artifact_id", json!(id)),
                            ("refs", json!(refs)),
                        ]),
                    ));
                }
            }
        }
        state.artifacts.remove(&id);
        Ok(record)
    })?;

    // Payload cleanup happens after the index commit; a failure here leaves
    // a detectable orphan, which list reports honestly. `rm force:true`
    // treats a missing dir as success — mirror that: NotFound still counts
    // as removed for state_copy.
    let dir = artifact_dir(artifact_id).map_err(RegError::Plain)?;
    let removed_payload = removed.storage.mode == "state_copy"
        && match fs::remove_dir_all(&dir) {
            Ok(()) => true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
            Err(_) => false,
        };
    Ok(DeleteResult {
        artifact_id: artifact_id.to_string(),
        storage_mode: removed.storage.mode,
        removed_payload,
    })
}

// --- verify (T3 #142) -------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifyStatus {
    Ok,
    Corrupt,
    Missing,
}

impl VerifyStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            VerifyStatus::Ok => "ok",
            VerifyStatus::Corrupt => "corrupt",
            VerifyStatus::Missing => "missing",
        }
    }
}

/// Per-artifact integrity verdict produced by `verify` (issue #142).
#[derive(Debug, Clone)]
pub struct ArtifactVerification {
    pub artifact_id: String,
    /// `ok` — payload present and hash/size/mime/metadata all consistent;
    /// `corrupt` — payload present but a check failed or the record's
    /// storage metadata is inconsistent; `missing` — payload absent,
    /// not a regular file, or unsafe (symlink inside the artifacts tree).
    pub status: VerifyStatus,
    /// Structured issue codes explaining a non-ok status.
    pub issues: Vec<String>,
    pub checks: VerifyChecks,
    /// The annotated record (same shape as `get`).
    pub artifact: AnnotatedArtifact,
}

#[derive(Debug, Clone, Default)]
pub struct VerifyChecks {
    pub payload_exists: bool,
    /// null when the payload could not be read.
    pub sha256_match: Option<bool>,
    pub size_match: Option<bool>,
    pub mime_match: Option<bool>,
}

impl ArtifactVerification {
    pub fn to_json(&self) -> Value {
        json!({
            "artifact_id": self.artifact_id,
            "status": self.status.as_str(),
            "issues": self.issues,
            "checks": {
                "payload_exists": self.checks.payload_exists,
                "sha256_match": self.checks.sha256_match,
                "size_match": self.checks.size_match,
                "mime_match": self.checks.mime_match,
            },
            "artifact": self.artifact.to_json(),
        })
    }
}

/// Re-check one record against the filesystem: payload existence,
/// sha256 re-hash, size, re-sniffed MIME, storage-layout consistency,
/// and oversize-flag consistency. Register-time warnings are historical
/// facts and are NOT re-reported as verify issues — only current
/// inconsistencies are.
fn verify_record(record: &ArtifactRecord, live: Option<&BTreeSet<String>>) -> ArtifactVerification {
    let annotated = annotate(record, live);
    let mut issues: Vec<String> = Vec::new();
    let mut checks = VerifyChecks::default();

    // Storage-layout consistency is a metadata check independent of
    // payload readability.
    let mut metadata_broken = false;
    let payload_path: Option<PathBuf> = if record.storage.mode == "state_copy" {
        match expected_stored_path(record) {
            Some(p) => Some(p),
            None => {
                metadata_broken = true;
                issues.push("storage_ref_invalid".to_string());
                None
            }
        }
    } else {
        Some(PathBuf::from(&record.storage.resolved_path))
    };

    let mut actual_size: Option<u64> = None;
    if let Some(payload_path) = payload_path {
        // state_copy payloads are lstat'ed so a symlink inside the
        // artifacts tree is never followed (ADR-0024 §2); path_ref
        // targets are external files and are stat'ed.
        let meta = if record.storage.mode == "state_copy" {
            fs::symlink_metadata(&payload_path).ok()
        } else {
            fs::metadata(&payload_path).ok()
        };
        let usable = match &meta {
            Some(m) => {
                if record.storage.mode == "state_copy" {
                    m.is_file() && !m.file_type().is_symlink()
                } else {
                    m.is_file()
                }
            }
            None => false,
        };
        if !usable {
            issues.push("storage_ref_missing".to_string());
        } else {
            checks.payload_exists = true;
            let info = meta.unwrap();
            actual_size = Some(info.len());
            let digest = sha256_file(&payload_path).unwrap_or_default();
            let head = read_head(&payload_path).unwrap_or_default();
            checks.sha256_match = Some(digest == record.sha256);
            checks.size_match = Some(info.len() as f64 == record.size);
            checks.mime_match = Some(sniff_mime(&head) == record.mime);
            if checks.sha256_match == Some(false) {
                issues.push("sha256_mismatch".to_string());
            }
            if checks.size_match == Some(false) {
                issues.push("size_mismatch".to_string());
            }
            if checks.mime_match == Some(false) {
                issues.push("mime_drift".to_string());
            }
        }
    }

    // The oversize flag must agree with the best-known current size
    // (actual payload size when readable, recorded size otherwise).
    let effective_size = actual_size.map(|s| s as f64).unwrap_or(record.size);
    if (effective_size > max_bytes(&record.kind) as f64) != record.oversize {
        issues.push("oversize_flag_inconsistent".to_string());
    }

    let status = if metadata_broken {
        VerifyStatus::Corrupt
    } else if !checks.payload_exists {
        VerifyStatus::Missing
    } else if issues.is_empty() {
        VerifyStatus::Ok
    } else {
        VerifyStatus::Corrupt
    };
    ArtifactVerification {
        artifact_id: record.artifact_id.clone(),
        status,
        issues,
        checks,
        artifact: annotated,
    }
}

pub struct VerifyOptions {
    /// Verify a single artifact; `None` verifies the whole index.
    pub artifact_id: Option<String>,
}

pub struct VerifySummary {
    pub total: usize,
    pub ok: usize,
    pub corrupt: usize,
    pub missing: usize,
}

pub struct VerifyReport {
    pub results: Vec<ArtifactVerification>,
    pub summary: VerifySummary,
    pub orphans: Vec<String>,
    pub corrupt: Vec<String>,
}

impl VerifyReport {
    pub fn to_json(&self) -> Value {
        json!({
            "results": self.results.iter().map(|r| r.to_json()).collect::<Vec<_>>(),
            "summary": {
                "total": self.summary.total,
                "ok": self.summary.ok,
                "corrupt": self.summary.corrupt,
                "missing": self.summary.missing,
            },
            "orphans": self.orphans,
            "corrupt": self.corrupt,
        })
    }
}

pub fn verify_artifacts(
    options: &VerifyOptions,
    snapshot: Option<&SessionSnapshot>,
) -> Result<VerifyReport, RegError> {
    let state = load_state().map_err(RegError::Plain)?;
    let mut records: Vec<ArtifactRecord> = state.artifacts.values().cloned().collect();
    if let Some(id) = &options.artifact_id {
        if !valid_artifact_id(id) {
            return Err(fail_extra(
                "artifact_not_found",
                "not_found",
                format!("unknown or malformed artifact_id: {}", id),
                extra_of(&[("artifact_id", json!(id))]),
            ));
        }
        match state.artifacts.get(id) {
            Some(r) => records = vec![r.clone()],
            None => {
                return Err(fail_extra(
                    "artifact_not_found",
                    "not_found",
                    format!("artifact not found: {}", id),
                    extra_of(&[("artifact_id", json!(id))]),
                ));
            }
        }
    }
    let live = live_pane_id_set(snapshot);
    let mut results: Vec<ArtifactVerification> = records
        .iter()
        .map(|r| verify_record(r, live.as_ref()))
        .collect();
    results.sort_by(|a, b| a.artifact_id.cmp(&b.artifact_id));
    let summary = VerifySummary {
        total: results.len(),
        ok: results.iter().filter(|r| r.status == VerifyStatus::Ok).count(),
        corrupt: results.iter().filter(|r| r.status == VerifyStatus::Corrupt).count(),
        missing: results.iter().filter(|r| r.status == VerifyStatus::Missing).count(),
    };
    let (orphans, corrupt) = list_tail(&state);
    Ok(VerifyReport {
        results,
        summary,
        orphans,
        corrupt,
    })
}

// --- Delivery (T4 #143, ADR-0024 §3) -----------------------------------------

/// v1 "attachment": the artifact's stable absolute path embedded in text
/// delivered through `agent.prompt` (target = pane hosting a live agent)
/// or `pane.send_text` (target = plain pane; literal text, no Enter).
/// There is no structured attachment API in herdr protocol 22 — the gap
/// is an upstream Issue candidate, not worked around (ADR-0024 §3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliverTargetKind {
    Agent,
    Pane,
}

impl DeliverTargetKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            DeliverTargetKind::Agent => "agent",
            DeliverTargetKind::Pane => "pane",
        }
    }
}

pub struct DeliverOptions {
    pub artifact_id: String,
    pub target_kind: DeliverTargetKind,
    pub pane_id: String,
    /// Optional free-text note appended to the delivery message.
    pub note: Option<String>,
    /// Live snapshot for target staleness checks (pane/agent existence).
    pub snapshot: SessionSnapshot,
    /// Socket/session resolution for the default transports.
    pub call_options: CallOptions,
}

pub struct DeliverResult {
    pub artifact_id: String,
    pub target_kind: DeliverTargetKind,
    pub pane_id: String,
    /// Wire method used: `agent.prompt` or `pane.send_text`.
    pub method: &'static str,
    /// The exact text sent — auditable, never fabricated.
    pub message: String,
    pub artifact: AnnotatedArtifact,
}

impl DeliverResult {
    pub fn to_json(&self) -> Value {
        json!({
            "artifact_id": self.artifact_id,
            "target": { "kind": self.target_kind.as_str(), "pane_id": self.pane_id },
            "method": self.method,
            "message": self.message,
            "artifact": self.artifact.to_json(),
        })
    }
}

/// Assemble the delivery text: a provenance-tagged header, the stable
/// absolute path on its own line (the v1 attachment), and minimal
/// metadata an agent needs to sanity-check what it is being handed.
pub fn build_delivery_text(record: &ArtifactRecord, note: Option<&str>) -> String {
    let title = record
        .title
        .as_ref()
        .map(|t| format!(" \"{}\"", t))
        .unwrap_or_default();
    let mut lines = vec![
        format!(
            "[artifacts] {} — {} artifact{}",
            record.artifact_id, record.kind, title
        ),
        format!("path: {}", record.storage.resolved_path),
        format!(
            "mime: {} · size: {} bytes · sha256: {}",
            record.mime,
            fmt_num(record.size),
            record.sha256
        ),
    ];
    if let Some(n) = note {
        if !n.is_empty() {
            lines.push(format!("note: {}", n));
        }
    }
    lines.join("\n")
}

/// Socket resolution mirroring the TS `socketFor` helper used by
/// agentPrompt/paneSendText: explicit socketPath wins; otherwise
/// `resolveSocketPath({session})` — which still honors ambient
/// HERDR_SOCKET_PATH/HERDR_SESSION inside resolveTarget.
fn deliver_socket_for(options: &CallOptions) -> Result<String, RegError> {
    if let Some(sp) = &options.socket_path {
        return Ok(sp.clone());
    }
    resolve_socket_path(&ResolveTargetOptions {
        session: options.session.clone(),
        socket_path: None,
        mutation: false,
    })
    .map_err(|e| RegError::Plain(e.to_string()))
}

fn rpc_code(err: &ClientError) -> Option<String> {
    match err {
        ClientError::Rpc(e) if !e.code.is_empty() => Some(e.code.clone()),
        _ => None,
    }
}

fn client_error_message(err: &ClientError) -> String {
    match err {
        ClientError::Io(m) => m.clone(),
        other => other.to_string(),
    }
}

/**
 * Deliver one artifact's path reference to a pane or its agent.
 *
 * Refusals (all structured, never silent):
 * - `artifact_not_found` — unknown/malformed id (from getArtifact).
 * - `missing_ref` — payload absent/unsafe; delivering a dead path
 *   would fabricate a usable attachment, so it is refused.
 * - `target_not_found` — pane id absent from the live snapshot (stale
 *   or wrong-session pane; never deliver into the void).
 * - `agent_not_found` — `--agent` target pane has no live agent in the
 *   snapshot (`agent.prompt` would be meaningless).
 * - `delivery_failed` — herdr rejected or the transport failed; the
 *   upstream RPC `code` (e.g. `agent_blocked`) is preserved in
 *   `rpc_code`.
 *
 * Delivery is side-effect free on the index: the sent text lives in
 * pane/agent scrollback, which is not durable state the plugin owns,
 * so no `refs` entry is fabricated (AGENTS §4).
 */
pub fn deliver_artifact(options: &DeliverOptions) -> Result<DeliverResult, RegError> {
    let artifact = get_artifact(&options.artifact_id, Some(&options.snapshot))?;
    if artifact.missing_ref {
        let mut extra = extra_of(&[("artifact_id", json!(options.artifact_id))]);
        extra.insert("warnings".to_string(), json!(artifact.warnings));
        return Err(fail_extra(
            "missing_ref",
            "not_found",
            format!(
                "artifact {} payload is missing; refusing to deliver a dead path",
                options.artifact_id
            ),
            extra,
        ));
    }

    let pane_id = &options.pane_id;
    if options.snapshot.pane(pane_id).is_none() {
        return Err(fail_extra(
            "target_not_found",
            "not_found",
            format!(
                "deliver target pane not present in live session: {}",
                pane_id
            ),
            extra_of(&[
                ("pane_id", json!(pane_id)),
                ("target_kind", json!(options.target_kind.as_str())),
            ]),
        ));
    }
    if options.target_kind == DeliverTargetKind::Agent
        && !options.snapshot.agents.contains_key(pane_id)
    {
        return Err(fail_extra(
            "agent_not_found",
            "not_found",
            format!("deliver target pane has no live agent: {}", pane_id),
            extra_of(&[
                ("pane_id", json!(pane_id)),
                ("target_kind", json!(options.target_kind.as_str())),
            ]),
        ));
    }

    let message = build_delivery_text(&artifact.record, options.note.as_deref());
    let socket = deliver_socket_for(&options.call_options)?;
    let timeout = options.call_options.timeout_ms.unwrap_or(10_000);
    let send_result = match options.target_kind {
        DeliverTargetKind::Agent => request(
            &socket,
            "agent.prompt",
            json!({ "target": pane_id, "text": message }),
            timeout,
        ),
        DeliverTargetKind::Pane => request(
            &socket,
            "pane.send_text",
            json!({ "pane_id": pane_id, "text": message }),
            timeout,
        ),
    };
    if let Err(err) = send_result {
        let mut extra = extra_of(&[
            ("pane_id", json!(pane_id)),
            ("target_kind", json!(options.target_kind.as_str())),
        ]);
        if let Some(code) = rpc_code(&err) {
            extra.insert("rpc_code".to_string(), json!(code));
        }
        return Err(fail_extra(
            "delivery_failed",
            "unavailable",
            format!(
                "deliver send failed for pane {}: {}",
                pane_id,
                client_error_message(&err)
            ),
            extra,
        ));
    }

    Ok(DeliverResult {
        artifact_id: artifact.record.artifact_id.clone(),
        target_kind: options.target_kind,
        pane_id: pane_id.clone(),
        method: if options.target_kind == DeliverTargetKind::Agent {
            "agent.prompt"
        } else {
            "pane.send_text"
        },
        message,
        artifact,
    })
}

// --- Retention (T4 #143) -------------------------------------------------------

pub struct GcOptions {
    /// ISO-8601; artifacts with created_at strictly before this are expired.
    pub older_than: String,
    /// Report only — no index or payload mutation.
    pub dry_run: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GcAction {
    Deleted,
    WouldDelete,
    Skipped,
}

impl GcAction {
    pub fn as_str(&self) -> &'static str {
        match self {
            GcAction::Deleted => "deleted",
            GcAction::WouldDelete => "would_delete",
            GcAction::Skipped => "skipped",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct GcEntry {
    pub artifact_id: String,
    pub action: GcAction,
    /// Why a candidate was not deleted.
    pub reason: Option<&'static str>,
    pub storage_mode: Option<String>,
    pub removed_payload: Option<bool>,
    pub error: Option<String>,
}

impl GcEntry {
    fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("artifact_id".to_string(), json!(self.artifact_id));
        m.insert("action".to_string(), json!(self.action.as_str()));
        if let Some(r) = self.reason {
            m.insert("reason".to_string(), json!(r));
        }
        if let Some(sm) = &self.storage_mode {
            m.insert("storage_mode".to_string(), json!(sm));
        }
        if let Some(rp) = self.removed_payload {
            m.insert("removed_payload".to_string(), json!(rp));
        }
        if let Some(e) = &self.error {
            m.insert("error".to_string(), json!(e));
        }
        Value::Object(m)
    }
}

#[derive(Debug, Default)]
pub struct GcTotals {
    pub evaluated: usize,
    pub expired: usize,
    pub deleted: usize,
    pub would_delete: usize,
    pub skipped_referenced: usize,
    pub skipped_other: usize,
    pub kept: usize,
    pub errors: usize,
}

pub struct GcResult {
    pub older_than: String,
    pub dry_run: bool,
    pub evaluated: usize,
    pub expired: usize,
    pub entries: Vec<GcEntry>,
    pub totals: GcTotals,
    pub orphans: Vec<String>,
    pub corrupt: Vec<String>,
}

impl GcResult {
    pub fn to_json(&self) -> Value {
        json!({
            "policy": { "older_than": self.older_than },
            "dry_run": self.dry_run,
            "evaluated": self.evaluated,
            "expired": self.expired,
            "entries": self.entries.iter().map(|e| e.to_json()).collect::<Vec<_>>(),
            "totals": {
                "evaluated": self.totals.evaluated,
                "expired": self.totals.expired,
                "deleted": self.totals.deleted,
                "would_delete": self.totals.would_delete,
                "skipped_referenced": self.totals.skipped_referenced,
                "skipped_other": self.totals.skipped_other,
                "kept": self.totals.kept,
                "errors": self.totals.errors,
            },
            "orphans": self.orphans,
            "corrupt": self.corrupt,
        })
    }
}

/**
 * `gc` — bounded retention for artifact records (contract v1, same
 * shape as checkpoints gc). Candidates are records whose `created_at`
 * is strictly before `--older-than`; among those, records carrying
 * `refs` (handoff/conversations/checkpoint back-references) are NEVER
 * collected — they are reported `skipped`/`referenced` and require an
 * explicit `delete --force`. `path_ref` records lose only their index
 * entry; external files are never removed by the plugin.
 *
 * Unparseable `created_at` is treated as not-provably-expired and
 * skipped — retention never guesses. Orphan payload dirs (no index
 * record) are reported via `orphans`, not collected: without a record
 * there is no honest age/ownership evidence. `--dry-run` performs the
 * full evaluation without mutating anything.
 *
 * gc needs no live herdr session — it is pure plugin-state work.
 */
pub fn gc_artifacts(options: &GcOptions) -> Result<GcResult, RegError> {
    let threshold = js_date_parse_ms(&options.older_than).ok_or_else(|| {
        RegError::Domain(RegistryError::new(
            "usage",
            "invalid",
            format!("--older-than must be an ISO-8601 timestamp: {}", options.older_than),
            None,
        ))
    })?;
    let state = load_state().map_err(RegError::Plain)?;
    let records: Vec<ArtifactRecord> = state.artifacts.values().cloned().collect();

    let mut entries: Vec<GcEntry> = Vec::new();
    let mut totals = GcTotals {
        evaluated: records.len(),
        ..Default::default()
    };

    let mut candidates: Vec<ArtifactRecord> = Vec::new();
    for record in &records {
        let created = js_date_parse_ms(&record.created_at);
        let Some(created) = created else {
            entries.push(GcEntry {
                artifact_id: record.artifact_id.clone(),
                action: GcAction::Skipped,
                reason: Some("invalid_created_at"),
                storage_mode: Some(record.storage.mode.clone()),
                ..Default::default()
            });
            totals.skipped_other += 1;
            continue;
        };
        if created >= threshold {
            totals.kept += 1;
            continue;
        }
        totals.expired += 1;
        if let Some(refs) = &record.refs {
            if !refs.is_empty() {
                entries.push(GcEntry {
                    artifact_id: record.artifact_id.clone(),
                    action: GcAction::Skipped,
                    reason: Some("referenced"),
                    storage_mode: Some(record.storage.mode.clone()),
                    ..Default::default()
                });
                totals.skipped_referenced += 1;
                continue;
            }
        }
        candidates.push(record.clone());
    }

    if options.dry_run {
        for record in &candidates {
            entries.push(GcEntry {
                artifact_id: record.artifact_id.clone(),
                action: GcAction::WouldDelete,
                storage_mode: Some(record.storage.mode.clone()),
                ..Default::default()
            });
            totals.would_delete += 1;
        }
    } else {
        for record in &candidates {
            match delete_artifact(&record.artifact_id, false) {
                Ok(removed) => {
                    entries.push(GcEntry {
                        artifact_id: record.artifact_id.clone(),
                        action: GcAction::Deleted,
                        storage_mode: Some(removed.storage_mode),
                        removed_payload: Some(removed.removed_payload),
                        ..Default::default()
                    });
                    totals.deleted += 1;
                }
                Err(err) => {
                    let message = match err {
                        RegError::Domain(e) => e.message,
                        RegError::Plain(m) => m,
                    };
                    entries.push(GcEntry {
                        artifact_id: record.artifact_id.clone(),
                        action: GcAction::Skipped,
                        reason: Some("delete_failed"),
                        storage_mode: Some(record.storage.mode.clone()),
                        error: Some(message),
                        ..Default::default()
                    });
                    totals.errors += 1;
                }
            }
        }
    }

    entries.sort_by(|a, b| a.artifact_id.cmp(&b.artifact_id));
    let (orphans, corrupt) = list_tail(&state);
    Ok(GcResult {
        older_than: options.older_than.clone(),
        dry_run: options.dry_run,
        evaluated: records.len(),
        expired: totals.expired,
        entries,
        totals,
        orphans,
        corrupt,
    })
}

// --- get (shared by deliver) -------------------------------------------------

pub fn get_artifact(
    artifact_id: &str,
    snapshot: Option<&SessionSnapshot>,
) -> Result<AnnotatedArtifact, RegError> {
    if !valid_artifact_id(artifact_id) {
        return Err(fail_extra(
            "artifact_not_found",
            "not_found",
            format!("unknown or malformed artifact_id: {}", artifact_id),
            extra_of(&[("artifact_id", json!(artifact_id))]),
        ));
    }
    let state = load_state().map_err(RegError::Plain)?;
    match state.artifacts.get(artifact_id) {
        Some(record) => Ok(annotate(record, live_pane_id_set(snapshot).as_ref())),
        None => Err(fail_extra(
            "artifact_not_found",
            "not_found",
            format!("artifact not found: {}", artifact_id),
            extra_of(&[("artifact_id", json!(artifact_id))]),
        )),
    }
}

// Re-export for cli convenience: session snapshot resolution failure is a
// CLI concern; keep the helper here so TUI shares the same mapping.
pub fn snapshot_or_fail(options: &CallOptions) -> Result<SessionSnapshot, RegError> {
    session_snapshot(options).map_err(|e| {
        RegError::Domain(RegistryError::new(
            "error",
            "session_unreachable",
            format!("herdr session unreachable: {}", command_error_message(&e)),
            None,
        ))
    })
}

fn command_error_message(e: &CommandError) -> String {
    match e {
        CommandError::Target(t) => t.to_string(),
        CommandError::Client(c) => client_error_message(c),
    }
}
