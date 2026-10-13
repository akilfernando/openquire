use crate::types::{Metadata, StampPosition};
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workflow {
    pub format: String,
    pub version: u32,
    pub name: String,
    pub steps: Vec<WorkflowStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action")]
pub enum WorkflowStep {
    #[serde(rename = "rotate")]
    Rotate { pages: String, delta: i32 },

    #[serde(rename = "deletePages")]
    DeletePages { pages: String },

    #[serde(rename = "stamp")]
    Stamp {
        pages: String,
        stamp: WorkflowStampSpec,
    },

    #[serde(rename = "markTerms")]
    MarkTerms { terms: Vec<String> },

    #[serde(rename = "markPatterns")]
    MarkPatterns { patterns: Vec<String> },

    #[serde(rename = "applyRedactions")]
    ApplyRedactions,

    #[serde(rename = "setMeta")]
    SetMeta { meta: Metadata },

    #[serde(rename = "pdfa")]
    PdfA { part: u32 },

    #[serde(rename = "ocr")]
    Ocr {
        lang: Option<String>,
        straighten: Option<bool>,
    },

    #[serde(rename = "plugin")]
    Plugin {
        plugin: String,
        command: String,
        name: Option<String>,
    },

    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowStampSpec {
    pub template: String,
    pub position: StampPosition,
    pub size: f32,
    #[serde(rename = "batesStart")]
    pub bates_start: Option<u64>,
    #[serde(rename = "batesDigits")]
    pub bates_digits: Option<usize>,
}

pub fn parse_workflow(json_str: &str) -> Result<Workflow> {
    let wf: Workflow = serde_json::from_str(json_str)
        .map_err(|e| anyhow!("Invalid OpenQuire workflow JSON: {}", e))?;
    if wf.format != "openquire-workflow" {
        return Err(anyhow!("Unsupported workflow format: {}", wf.format));
    }
    Ok(wf)
}
