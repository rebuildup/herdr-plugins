//! Incremental transcript scanner for rebuildup.conversations.
//!
//! Rust port of `plugins/conversations/src/indexer.ts` (retired; git
//! history preserves it). Byte-offset cursor + a small FNV-1a guard over
//! the bytes preceding the resume offset, so an in-place rewrite is
//! detected and the transcript re-indexed from 0 instead of silently
//! skipping or double counting. Only newline-terminated lines are
//! committed; an unterminated tail waits for the next scan. The cursor
//! also carries the committed line count so provider line numbers (and
//! `file:line` event-id fallbacks) stay stable across resumes.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde_json::Value;

use crate::model::ConversationEvent;

/// Bytes of pre-offset content hashed as the rewrite guard.
pub const GUARD_LENGTH: u64 = 4096;
/// Read chunk size; lines are accumulated across chunks.
const READ_CHUNK_BYTES: usize = 256 * 1024;

pub fn fnv1a(buffer: &[u8]) -> u32 {
    let mut hash: u32 = 0x811c9dc5;
    for &b in buffer {
        hash ^= b as u32;
        hash = hash.wrapping_mul(0x01000193);
    }
    hash
}

/// Guard hash over up to GUARD_LENGTH bytes ending at `offset`.
/// Returns None when the window cannot be read fully (mirrors -1).
fn guard_hash_at(file: &mut File, offset: u64) -> Option<u32> {
    let length = GUARD_LENGTH.min(offset);
    if length == 0 {
        return Some(0);
    }
    let mut window = vec![0u8; length as usize];
    file.seek(SeekFrom::Start(offset - length)).ok()?;
    let mut read = 0usize;
    while read < window.len() {
        match file.read(&mut window[read..]) {
            Ok(0) => return None,
            Ok(n) => read += n,
            Err(_) => return None,
        }
    }
    Some(fnv1a(&window))
}

#[derive(Debug, Clone, Default)]
pub struct TranscriptCursor {
    pub offset: u64,
    pub size: u64,
    pub mtime_ms: f64,
    /// Newline-terminated lines committed so far (1-based numbering base).
    pub line_count: u64,
}

#[derive(Debug, Default)]
pub struct ScanResult {
    pub events: Vec<ConversationEvent>,
    /// New cursor to persist; None when the file could not be scanned.
    pub cursor: Option<TranscriptCursor>,
    pub scanned_bytes: u64,
    /// True when the guard/shrink check forced a from-0 rescan.
    pub reindexed: bool,
    /// Lines that looked like JSON but failed to parse.
    pub malformed_lines: u64,
    /// Guard hash at the new cursor offset; persist for the next resume.
    pub guard_hash: Option<u32>,
    /// Adapter turn counter after this scan; persist for turn_index continuity.
    pub turn_index: i64,
    /// Set when the transcript could not be read at all.
    pub error: Option<String>,
}

impl ScanResult {
    fn fail(error: Option<String>) -> Self {
        ScanResult {
            error,
            ..Default::default()
        }
    }
}

/// Stateful line parser produced once per scan (adapters keep
/// cross-line state inside the impl). `out` is the scan's event sink:
/// adapters append produced events AND may mutate earlier entries
/// (codex attaches usage to a previous line's assistant_message).
pub trait LineParser {
    /// Parse one 1-based-numbered line, appending events to `out`.
    fn parse_line(&mut self, line: &str, line_number: u64, out: &mut Vec<ConversationEvent>);
    /// Adapter turn counter (persisted for resume continuity).
    fn turn_index(&self) -> i64;
}

fn looks_like_json(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with('{') || t.starts_with('[')
}

fn parses_as_json(line: &str) -> bool {
    serde_json::from_str::<Value>(line).is_ok()
}

/// Scan `file_path` incrementally. `cursor` is the previously persisted
/// position (None = first scan). `expected_guard_hash` is the guard
/// persisted with the cursor; `parser_factory` is invoked once per scan
/// and returns the stateful line parser.
pub fn scan_transcript(
    file_path: &str,
    cursor: Option<&TranscriptCursor>,
    expected_guard_hash: Option<u32>,
    // Persisted adapter turn counter (`record.turn_count`); reset to 0
    // internally when the scan reindexes.
    start_turn: i64,
    parser_factory: impl FnOnce(i64, u64) -> Box<dyn LineParser>,
) -> ScanResult {
    let path = Path::new(file_path);
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return ScanResult::fail(Some("transcript_missing".to_string())),
    };
    let file_size = meta.len();
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        // TS `info.mtimeMs` is a float with sub-ms precision.
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);

    // Resume requires: prior cursor, file not shrunk, and the guard hash
    // over the bytes preceding the offset still matching (in-place
    // rewrite detection — same mechanism as the TS indexer).
    let mut offset = 0u64;
    let mut line_base = 0u64;
    let mut reindexed = false;
    if let Some(c) = cursor {
        if c.offset > 0 {
            if file_size < c.offset {
                reindexed = true;
            } else {
                match File::open(path) {
                    Ok(mut probe) => {
                        match guard_hash_at(&mut probe, c.offset) {
                            Some(guard)
                                if expected_guard_hash.is_some()
                                    && expected_guard_hash == Some(guard) =>
                            {
                                offset = c.offset;
                                line_base = c.line_count;
                            }
                            _ => reindexed = true,
                        }
                    }
                    Err(_) => reindexed = true,
                }
            }
        }
    }

    // startTurn seeds the adapter's turn counter so turn_index stays
    // monotonic across resumes; a reindexed scan restarts at 0.
    let effective_start_turn = if reindexed { 0 } else { start_turn };
    let mut parser = parser_factory(effective_start_turn, line_base);

    let mut events: Vec<ConversationEvent> = Vec::new();
    let mut malformed = 0u64;
    let mut committed_offset = offset;
    let mut committed_lines = line_base;
    let mut pending: Vec<u8> = Vec::new();

    let mut handle = match File::open(path) {
        Ok(f) => f,
        Err(e) => return ScanResult::fail(Some(e.to_string())),
    };
    if handle.seek(SeekFrom::Start(offset)).is_err() {
        return ScanResult::fail(Some("seek_failed".to_string()));
    }

    let mut chunk = vec![0u8; READ_CHUNK_BYTES];
    loop {
        match handle.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                pending.extend_from_slice(&chunk[..n]);
                // Process every complete line in pending.
                let mut start = 0usize;
                for (i, &b) in pending.iter().enumerate() {
                    if b == b'\n' {
                        let mut line_buf = &pending[start..i];
                        if line_buf.last() == Some(&b'\r') {
                            line_buf = &line_buf[..line_buf.len() - 1];
                        }
                        committed_lines += 1;
                        let line = String::from_utf8_lossy(line_buf).into_owned();
                        let before = events.len();
                        parser.parse_line(&line, committed_lines, &mut events);
                        if events.len() == before
                            && looks_like_json(&line)
                            && !parses_as_json(&line)
                        {
                            malformed += 1;
                        }
                        committed_offset += (i - start + 1) as u64;
                        start = i + 1;
                    }
                }
                pending.drain(..start);
            }
            Err(e) => return ScanResult::fail(Some(e.to_string())),
        }
    }
    drop(handle);

    let guard_hash = if committed_offset > 0 {
        File::open(path)
            .ok()
            .and_then(|mut f| guard_hash_at(&mut f, committed_offset))
    } else {
        None
    };

    ScanResult {
        events,
        cursor: Some(TranscriptCursor {
            offset: committed_offset,
            size: file_size,
            mtime_ms,
            line_count: committed_lines,
        }),
        scanned_bytes: committed_offset - offset,
        reindexed,
        malformed_lines: malformed,
        guard_hash,
        turn_index: parser.turn_index(),
        error: None,
    }
}
