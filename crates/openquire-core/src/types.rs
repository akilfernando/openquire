use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Metadata {
    pub title: Option<String>,
    pub author: Option<String>,
    pub subject: Option<String>,
    pub keywords: Option<String>,
    pub creator: Option<String>,
    pub producer: Option<String>,
    pub creation_date: Option<String>,
    pub mod_date: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StampPosition {
    Tl,
    Tc,
    Tr,
    Bl,
    Bc,
    Br,
    Center,
}

impl Default for StampPosition {
    fn default() -> Self {
        Self::Bc
    }
}

impl std::str::FromStr for StampPosition {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "tl" => Ok(Self::Tl),
            "tc" => Ok(Self::Tc),
            "tr" => Ok(Self::Tr),
            "bl" => Ok(Self::Bl),
            "bc" => Ok(Self::Bc),
            "br" => Ok(Self::Br),
            "center" => Ok(Self::Center),
            _ => Err(format!("Unknown stamp position '{s}'")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CompressLevel {
    Standard,
    Medium,
    Strong,
}

impl Default for CompressLevel {
    fn default() -> Self {
        Self::Standard
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StampSpec {
    pub template: String,
    pub position: StampPosition,
    pub size: f32,
    pub bates_start: Option<u64>,
    pub bates_digits: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentInfo {
    pub file_name: String,
    pub pages: usize,
    pub encrypted: bool,
    pub metadata: Metadata,
    pub signatures: Vec<String>,
    pub tagged: bool,
    pub pdfa_status: Option<String>,
    pub form_fields_count: usize,
    pub comments_count: usize,
}

pub const BUILTIN_REDACTION_PATTERNS: &[(&str, &str)] = &[
    ("email", r"[\w.+-]+@[\w-]+(\.[\w-]+)+"),
    ("phone", r"\+?\d[\d ()-]{7,}\d"),
    ("card", r"\b(?:\d[ -]?){13,19}\b"),
    ("date", r"\b\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}\b"),
    ("url", r"https?://\S+"),
];

pub fn resolve_pattern(name_or_regex: &str) -> &str {
    for (name, pat) in BUILTIN_REDACTION_PATTERNS {
        if *name == name_or_regex {
            return pat;
        }
    }
    name_or_regex
}
