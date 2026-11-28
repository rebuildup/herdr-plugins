//! Shared contract constants and record types for
//! rebuildup.artifacts (`herdr-plugins.artifacts/v1`, STABLE — ADR-0024).
//! Rust port of `plugins/artifacts/src/model.ts`.
//!
//! T1 (#136) fixed identity, kinds, storage modes, and size caps; T2
//! (#141) adds the persisted artifact record shape consumed by the
//! registry core (state.rs / registry.rs); T4 (#143) stabilizes v1 with
//! deliver/gc/export.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

pub const PLUGIN_ID: &str = "rebuildup.artifacts";
pub const CONTRACT: &str = "herdr-plugins.artifacts/v1";
/// Contract maturity: "stable" since T4 (#143) shipped deliver/gc/export.
pub const CONTRACT_STATUS: &str = "stable";
pub const PLUGIN_VERSION: &str = "0.2.0";

/// Artifact kinds, mirroring upstream T3 attachment kinds.
pub const ARTIFACT_KINDS: [&str; 5] = ["html", "image", "pdf", "file", "other"];

/// Storage modes (ADR-0024 §2).
pub const STORAGE_MODES: [&str; 2] = ["state_copy", "path_ref"];

/// Draft per-kind copy caps in bytes (upstream T3 values: image 10 MiB,
/// HTML page 25 MiB; pdf/file/other aligned to 25 MiB). `path_ref`
/// records are never refused for size — oversize becomes a warning.
pub fn max_bytes(kind: &str) -> u64 {
    match kind {
        "image" => 10 * 1024 * 1024,
        _ => 25 * 1024 * 1024,
    }
}

/// artifact_id shape enforced on every retrieval path (traversal guard).
/// Mirrors `/^art-[A-Za-z0-9_-]+$/`; `ARTIFACT_ID_PATTERN_SOURCE` is the
/// regex `.source` emitted in the capability document.
pub const ARTIFACT_ID_PATTERN_SOURCE: &str = "^art-[A-Za-z0-9_-]+$";
pub fn valid_artifact_id(id: &str) -> bool {
    // /^art-[A-Za-z0-9_-]+$/
    let rest = match id.strip_prefix("art-") {
        Some(r) if !r.is_empty() => r,
        _ => return false,
    };
    rest.bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Who initiated registration (contract `owner.created_by`).
pub const CREATED_BY: [&str; 6] = ["pane", "agent", "handoff", "script", "cli", "unknown"];

/// State index schema version (`state.json`).
pub const STATE_SCHEMA_VERSION: u64 = 1;

// ---------------------------------------------------------------------------
// Artifact record (serde shape mirrors the TS interface field-for-field)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ArtifactOwner {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    /// Provider session value reported by the pane's agent, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_session: Option<String>,
    pub created_by: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ArtifactStorage {
    pub mode: String,
    #[serde(rename = "ref")]
    pub ref_: String,
    pub resolved_path: String,
}

/// Advisory render metadata recorded at register time (contract `meta`).
/// For `kind:"html"` the plugin records that consumers must render the
/// document inside an isolated context; sandbox/CSP/network policy is
/// always the client's responsibility (ADR-0024 §4). The plugin never
/// executes or renders content itself.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ArtifactMeta {
    pub render: ArtifactRenderMeta,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ArtifactRenderMeta {
    /// HTML documents must be rendered in an isolated context.
    pub isolation: String,
    /// Enforcement point for sandbox/CSP/network policy.
    pub policy: String,
}

/// One durable artifact record — the contract's artifact record
/// (docs/contracts/artifacts-v1.md §Artifact record). `storage.ref` is
/// state-relative for `state_copy` (`artifacts/<id>/<name>`) and the
/// resolved realpath for `path_ref`; `resolved_path` is always the
/// absolute path a consumer may open.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ArtifactRecord {
    pub contract: String,
    pub artifact_id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Host identity of the registering herdr installation.
    pub host: String,
    /// herdr session name the artifact was registered under.
    pub session: String,
    pub owner: ArtifactOwner,
    pub storage: ArtifactStorage,
    /// File size in bytes. Serialized as an integer when integral so the
    /// on-disk JSON matches the TS writer (`12345`, not `12345.0`).
    #[serde(serialize_with = "serialize_size")]
    pub size: f64,
    pub mime: String,
    pub sha256: String,
    /// path_ref only: true when size exceeded the per-kind cap at register.
    pub oversize: bool,
    pub created_at: String,
    /// Additive back-references (conversations event, handoff payload, checkpoint).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refs: Option<Vec<String>>,
    /// Structured warnings recorded at register (e.g. mime_mismatch, oversize).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warnings: Option<Vec<String>>,
    /// Advisory metadata (e.g. html render isolation notice).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<ArtifactMeta>,
}

fn serialize_size<S: serde::Serializer>(size: &f64, ser: S) -> Result<S::Ok, S::Error> {
    if size.fract() == 0.0 && *size >= 0.0 && *size <= u64::MAX as f64 {
        ser.serialize_u64(*size as u64)
    } else {
        ser.serialize_f64(*size)
    }
}

// ---------------------------------------------------------------------------
// Tolerant record parser (state load quarantine path)
// ---------------------------------------------------------------------------

fn as_string(value: &Value) -> Option<String> {
    value.as_str().and_then(|s| {
        if s.is_empty() {
            None
        } else {
            Some(s.to_string())
        }
    })
}

fn as_string_opt(value: Option<&Value>) -> Option<String> {
    value.and_then(as_string)
}

fn as_string_array(value: &Value) -> Option<Vec<String>> {
    let arr = value.as_array()?;
    let out: Vec<String> = arr
        .iter()
        .filter_map(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn as_string_array_opt(value: Option<&Value>) -> Option<Vec<String>> {
    value.and_then(as_string_array)
}

/// Tolerant meta parser: `meta` is advisory, derived data, so a
/// malformed persisted value is dropped rather than quarantining the
/// whole record.
fn parse_artifact_meta(value: &Value) -> Option<ArtifactMeta> {
    let render = value.get("render")?;
    if !render.is_object() {
        return None;
    }
    if render.get("isolation").and_then(|v| v.as_str()) != Some("required")
        || render.get("policy").and_then(|v| v.as_str()) != Some("client")
    {
        return None;
    }
    Some(ArtifactMeta {
        render: ArtifactRenderMeta {
            isolation: "required".to_string(),
            policy: "client".to_string(),
        },
    })
}

/// Tolerant record parser: malformed persisted entries return None so the
/// state loader can quarantine them into `state.corrupt` instead of
/// failing the whole index (deterministic, honest — never silently
/// dropped into success).
pub fn parse_artifact_record(value: &Value) -> Option<ArtifactRecord> {
    let v = value.as_object()?;
    let artifact_id = as_string(v.get("artifact_id")?)?;
    if !valid_artifact_id(&artifact_id) {
        return None;
    }
    let kind = as_string(v.get("kind")?)?;
    if !ARTIFACT_KINDS.contains(&kind.as_str()) {
        return None;
    }
    let host = as_string(v.get("host")?)?;
    let session = as_string(v.get("session")?)?;
    let created_at = as_string(v.get("created_at")?)?;
    let sha256 = as_string(v.get("sha256")?)?;
    let mime = as_string(v.get("mime")?)?;
    let size = v.get("size")?.as_f64()?;
    if !size.is_finite() || size < 0.0 {
        return None;
    }
    let storage = v.get("storage")?;
    let owner = v.get("owner")?;
    if !storage.is_object() || !owner.is_object() {
        return None;
    }
    let s = storage.as_object()?;
    let mode = as_string(s.get("mode")?)?;
    if !STORAGE_MODES.contains(&mode.as_str()) {
        return None;
    }
    let ref_ = as_string(s.get("ref")?)?;
    let resolved_path = as_string(s.get("resolved_path")?)?;
    let o = owner.as_object()?;
    // created_by is optional in the tolerant reader: a missing/malformed
    // value degrades to "unknown", never quarantines the record.
    let created_by = as_string_opt(o.get("created_by"))
        .filter(|c| CREATED_BY.contains(&c.as_str()))
        .unwrap_or_else(|| "unknown".to_string());

    let mut record = ArtifactRecord {
        contract: CONTRACT.to_string(),
        artifact_id,
        kind,
        title: None,
        host,
        session,
        owner: ArtifactOwner {
            pane_id: None,
            agent_session: None,
            created_by,
        },
        storage: ArtifactStorage {
            mode,
            ref_: ref_.to_string(),
            resolved_path,
        },
        size,
        mime,
        sha256,
        oversize: v.get("oversize").and_then(|x| x.as_bool()) == Some(true),
        created_at,
        refs: None,
        warnings: None,
        meta: None,
    };
    record.title = as_string_opt(v.get("title"));
    record.owner.pane_id = as_string_opt(o.get("pane_id"));
    record.owner.agent_session = as_string_opt(o.get("agent_session"));
    record.refs = as_string_array_opt(v.get("refs"));
    record.warnings = as_string_array_opt(v.get("warnings"));
    record.meta = v.get("meta").and_then(parse_artifact_meta);
    Some(record)
}

/// Commands that exist in the contract but are not implemented in this
/// revision. Empty since T4 (#143): v1 is stable and complete.
pub const PLANNED_COMMANDS: [&str; 0] = [];

/// Implemented commands (T1 capability/help + T2 registry + T3 verify + T4 deliver/gc/export).
pub const IMPLEMENTED_COMMANDS: [&str; 11] = [
    "capability",
    "help",
    "register",
    "list",
    "get",
    "search",
    "verify",
    "delete",
    "deliver",
    "gc",
    "export",
];

// ---------------------------------------------------------------------------
// Kind / mime / filename helpers (registry.ts pure functions)
// ---------------------------------------------------------------------------

const SNIFF_BYTES: usize = 8192;

/// True when `c` is a JS-`\s` whitespace char (Unicode White_Space plus
/// the JS-only extras). Rust `char::is_whitespace` covers Unicode
/// White_Space; JS `\s` additionally matches U+FEFF — handled by the BOM
/// strip before this point, so plain is_whitespace suffices here.
fn js_space(c: char) -> bool {
    c.is_whitespace()
}

/// Upstream `HtmlRender` document-start rule (anchored, BOM tolerated):
/// `^\s*<(?:!doctype\s+html|html)[\s>]` case-insensitive.
pub fn is_html_document_start(text: &str) -> bool {
    let body = text.strip_prefix('\u{feff}').unwrap_or(text);
    let chars: Vec<char> = body.chars().collect();
    let mut i = 0usize;
    while i < chars.len() && js_space(chars[i]) {
        i += 1;
    }
    if i >= chars.len() || chars[i] != '<' {
        return false;
    }
    i += 1;
    let rest: String = chars[i..].iter().collect::<String>().to_lowercase();
    if let Some(after) = rest.strip_prefix("!doctype") {
        // `!doctype\s+html` — at least one whitespace is REQUIRED.
        let mut it = after.chars();
        match it.next() {
            Some(c) if js_space(c) => {}
            _ => return false,
        }
        let trimmed: String = it.collect::<String>().trim_start().to_string();
        if let Some(r) = trimmed.strip_prefix("html") {
            return r
                .chars()
                .next()
                .map(|c| js_space(c) || c == '>')
                .unwrap_or(false);
        }
        return false;
    }
    if let Some(r) = rest.strip_prefix("html") {
        return r
            .chars()
            .next()
            .map(|c| js_space(c) || c == '>')
            .unwrap_or(false);
    }
    false
}

/// Upstream `HtmlRender` file rule: resolved path must end in .html/.htm.
pub fn is_html_file_name(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".html") || lower.ends_with(".htm")
}

/// Leading-byte MIME sniff (upstream attachmentStore rules, draft subset).
pub fn sniff_mime(head: &[u8]) -> String {
    if head.len() >= 5 && &head[0..5] == b"%PDF-" {
        return "application/pdf".to_string();
    }
    if head.len() >= 8 && head[0..8] == [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] {
        return "image/png".to_string();
    }
    if head.len() >= 3 && head[0] == 0xff && head[1] == 0xd8 && head[2] == 0xff {
        return "image/jpeg".to_string();
    }
    if head.len() >= 6 && (&head[0..6] == b"GIF87a" || &head[0..6] == b"GIF89a") {
        return "image/gif".to_string();
    }
    if head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        return "image/webp".to_string();
    }
    if head.len() >= 2 && &head[0..2] == b"BM" {
        return "image/bmp".to_string();
    }
    // Text-ish content: decode and look for HTML/SVG shape in the prefix.
    if head.contains(&0) {
        return "application/octet-stream".to_string();
    }
    let text = String::from_utf8_lossy(head);
    // BOM-tolerant body, matching `text.charCodeAt(0) === 0xfeff` slice.
    let body = text.strip_prefix('\u{feff}').unwrap_or(&text);
    if is_html_document_start(body) {
        return "text/html".to_string();
    }
    // body.slice(0, 1024).toLowerCase() — JS counts UTF-16 units; taking
    // the first 1024 chars is the closest char-faithful bound.
    let lower: String = body.chars().take(1024).collect::<String>().to_lowercase();
    let trimmed = lower.trim_start();
    if trimmed.starts_with("<?xml") {
        let after = &trimmed[5..];
        if after
            .chars()
            .next()
            .map(|c| js_space(c) || c == '?')
            .unwrap_or(false)
            && lower.contains("<svg")
        {
            return "image/svg+xml".to_string();
        }
    }
    if trimmed.starts_with("<svg") {
        return "image/svg+xml".to_string();
    }
    "text/plain".to_string()
}

/// Extension → concrete MIME used for sniff-vs-extension mismatch warnings.
fn ext_mime(ext: &str) -> Option<&'static str> {
    Some(match ext {
        ".png" => "image/png",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".bmp" => "image/bmp",
        ".svg" => "image/svg+xml",
        ".pdf" => "application/pdf",
        ".html" | ".htm" => "text/html",
        _ => return None,
    })
}

fn kind_by_ext(ext: &str) -> Option<&'static str> {
    Some(match ext {
        ".html" | ".htm" => "html",
        ".png" | ".jpg" | ".jpeg" | ".gif" | ".webp" | ".bmp" | ".svg" | ".ico" => "image",
        ".pdf" => "pdf",
        _ => return None,
    })
}

/// Lowercased extension including the leading dot, mirroring JS
/// `path.extname` on the platform path separator ("" when there is no
/// extension; a leading-dot filename like ".gitignore" has none; a
/// trailing dot yields ".").
pub fn file_ext(filename: &str) -> String {
    let base = Path::new(filename)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| filename.to_string());
    match base.rfind('.') {
        // Dot at position 0 with no earlier dot → dotfile, no extension
        // (JS extname(".gitignore") === "").
        Some(0) => String::new(),
        Some(i) => format!(".{}", &base[i + 1..]).to_lowercase(),
        None => String::new(),
    }
}

/// Kind inference when --kind is omitted: extension first, then MIME.
pub fn detect_kind(filename: &str, mime: &str) -> String {
    let ext = file_ext(filename);
    if let Some(k) = kind_by_ext(&ext) {
        return k.to_string();
    }
    if mime == "text/html" {
        return "html".to_string();
    }
    if mime == "application/pdf" {
        return "pdf".to_string();
    }
    if mime.starts_with("image/") {
        return "image".to_string();
    }
    "file".to_string()
}

/// Path-safe stored filename: basename, restricted charset, bounded length.
pub fn sanitize_filename(name: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_string());
    let replaced: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    // strip leading dots, then cap at 120 chars (input is ASCII-only here)
    let trimmed: String = replaced.trim_start_matches('.').chars().take(120).collect();
    if trimmed.is_empty() {
        "artifact".to_string()
    } else {
        trimmed
    }
}

/// Extension→MIME lookup used by registry warnings.
pub fn ext_mime_for(ext: &str) -> Option<&'static str> {
    ext_mime(ext)
}

/// Head-length cap shared with the registry sniff path.
pub const SNIFF_BYTES: usize = 8192;

/// `max_bytes` map for the capability document.
pub fn max_bytes_map() -> BTreeMap<&'static str, u64> {
    let mut m = BTreeMap::new();
    for k in ARTIFACT_KINDS {
        m.insert(k, max_bytes(k));
    }
    m
}

// ---------------------------------------------------------------------------
// Date.parse subset (CLI --since/--until/--older-than validation + gc)
// ---------------------------------------------------------------------------

/// `Date.parse` subset returning epoch milliseconds. Covers the ISO-8601
/// forms tests and agents actually pass: full RFC3339 (offset/Z,
/// fractional seconds), date-only `YYYY-MM-DD` (UTC midnight per spec),
/// and naive `YYYY-MM-DD[T ]HH:MM[:SS[.fff]]` interpreted in local time
/// (JS semantics). Returns None where JS would produce NaN. Implementation-
/// defined JS formats ("01/02/2026", "Jan 2 2026", …) are intentionally
/// not accepted — they are ambiguous and never appear in contract use.
pub fn js_date_parse_ms(raw: &str) -> Option<f64> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    // 1. RFC3339 / ISO with explicit offset or Z.
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(dt.timestamp_millis() as f64);
    }
    // 2. ISO local forms: YYYY-MM-DD, YYYY-MM-DDTHH:MM[:SS[.frac]],
    //    also space-separated (JS accepts both separators).
    let normalized = s.replacen(' ', "T", 1);
    // date-only → UTC midnight (ECMAScript spec).
    if let Ok(d) = chrono::NaiveDate::parse_from_str(&normalized, "%Y-%m-%d") {
        return Some(d.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis() as f64);
    }
    use chrono::TimeZone;
    for fmt in [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%dT%H:%M:%S",
    ] {
        if let Ok(ndt) = chrono::NaiveDateTime::parse_from_str(&normalized, fmt) {
            // Naive date-time → local time, matching JS Date.parse.
            let local = chrono::Local
                .from_local_datetime(&ndt)
                .single()?;
            return Some(local.timestamp_millis() as f64);
        }
    }
    None
}
