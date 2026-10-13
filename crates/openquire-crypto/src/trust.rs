//! Certificate trust store and chain validation.

use crate::pki::{parse_cert_der, parse_certs_pem, CertInfo};
use anyhow::{anyhow, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const BUNDLED_ROOTS_JSON: &str = include_str!("../../../src/engine/roots.json");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustReport {
    pub trusted: bool,
    pub root_signer: Option<String>,
    pub issues: Vec<String>,
}

#[derive(Default)]
pub struct TrustStore {
    /// Roots mapped by SHA-256 fingerprint (lowercase hex).
    roots_by_fingerprint: HashMap<String, CertInfo>,
    /// Roots mapped by subject DN.
    roots_by_subject: HashMap<String, Vec<CertInfo>>,
}

impl TrustStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn load_bundled() -> Result<Self> {
        let mut store = Self::new();
        let pem_list: Vec<String> = serde_json::from_str(BUNDLED_ROOTS_JSON)
            .map_err(|e| anyhow!("Failed to parse bundled roots.json: {}", e))?;
        for pem in pem_list {
            if let Ok(certs) = parse_certs_pem(&pem) {
                for cert in certs {
                    store.add_cert(cert);
                }
            }
        }
        Ok(store)
    }

    pub fn add_cert(&mut self, cert: CertInfo) {
        self.roots_by_fingerprint.insert(cert.sha256_fingerprint.clone(), cert.clone());
        self.roots_by_subject
            .entry(cert.subject.clone())
            .or_default()
            .push(cert);
    }

    pub fn add_der(&mut self, der: &[u8]) -> Result<()> {
        let cert = parse_cert_der(der)?;
        self.add_cert(cert);
        Ok(())
    }

    pub fn is_trusted_root(&self, cert: &CertInfo) -> bool {
        self.roots_by_fingerprint.contains_key(&cert.sha256_fingerprint)
    }

    pub fn verify_chain(&self, chain: &[CertInfo]) -> TrustReport {
        let mut issues = Vec::new();
        if chain.is_empty() {
            return TrustReport {
                trusted: false,
                root_signer: None,
                issues: vec!["Empty certificate chain".to_string()],
            };
        }

        let now = Utc::now();

        // 1. Check validity window for all certificates in chain
        for (idx, cert) in chain.iter().enumerate() {
            if now < cert.not_before {
                issues.push(format!(
                    "Certificate {} ({}) is not yet valid (valid from {})",
                    idx, cert.subject, cert.not_before
                ));
            }
            if now > cert.not_after {
                issues.push(format!(
                    "Certificate {} ({}) has expired (expired at {})",
                    idx, cert.subject, cert.not_after
                ));
            }
        }

        // 2. Check chain continuity (each cert's issuer is next cert's subject)
        for i in 0..chain.len() - 1 {
            let child = &chain[i];
            let parent = &chain[i + 1];
            if child.issuer != parent.subject {
                issues.push(format!(
                    "Certificate {} issuer ({}) does not match certificate {} subject ({})",
                    i, child.issuer, i + 1, parent.subject
                ));
            }
        }

        // 3. Check if the top of the chain is a trusted root
        let top = chain.last().unwrap();
        let mut is_trusted = false;
        let mut root_signer = None;

        if self.is_trusted_root(top) {
            is_trusted = true;
            root_signer = Some(top.subject.clone());
        } else if let Some(candidates) = self.roots_by_subject.get(&top.issuer) {
            // Self-signed root was not included in chain, but the issuer is in our store
            if let Some(root) = candidates.first() {
                is_trusted = true;
                root_signer = Some(root.subject.clone());
            }
        }

        if !is_trusted {
            issues.push(format!("Certificate chain root ({}) is not in trusted root store", top.subject));
        }

        TrustReport {
            trusted: is_trusted && issues.is_empty(),
            root_signer,
            issues,
        }
    }
}
