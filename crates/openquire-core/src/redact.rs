//! Native redaction is unavailable until it meets the shared removal contract.
use lopdf::{Document, ObjectId};
use regex::Regex;

pub fn redact_document(_doc: &mut Document, _regexes: &[Regex], _terms: &[String]) -> anyhow::Result<usize> {
    anyhow::bail!("Native redaction is not supported; use the Node CLI or app")
}

pub fn redact_page(_doc: &mut Document, _page_id: ObjectId, _regexes: &[Regex], _terms: &[String]) -> anyhow::Result<usize> {
    anyhow::bail!("Native redaction is not supported; use the Node CLI or app")
}
