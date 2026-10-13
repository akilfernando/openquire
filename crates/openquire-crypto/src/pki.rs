//! X.509 Certificate parsing and handling.

use anyhow::{anyhow, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use x509_parser::extensions::{GeneralName, ParsedExtension};
use x509_parser::prelude::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CertInfo {
    pub subject: String,
    pub issuer: String,
    pub serial_hex: String,
    pub not_before: DateTime<Utc>,
    pub not_after: DateTime<Utc>,
    pub sha256_fingerprint: String,
    pub is_ca: bool,
    pub ocsp_url: Option<String>,
    pub crl_urls: Vec<String>,
    pub der: Vec<u8>,
}

fn time_to_datetime(t: &ASN1Time) -> DateTime<Utc> {
    DateTime::from_timestamp(t.timestamp(), 0).unwrap_or_else(|| Utc::now())
}

pub fn parse_cert_der(der_bytes: &[u8]) -> Result<CertInfo> {
    let (_, cert) = parse_x509_certificate(der_bytes)
        .map_err(|e| anyhow!("Failed to parse X.509 certificate: {:?}", e))?;

    let subject_dn = cert.subject().to_string();
    let issuer_dn = cert.issuer().to_string();

    let serial_hex = cert.serial.to_str_radix(16);
    let not_before = time_to_datetime(&cert.validity().not_before);
    let not_after = time_to_datetime(&cert.validity().not_after);

    let mut hasher = Sha256::new();
    hasher.update(der_bytes);
    let sha256_fingerprint = hex::encode(hasher.finalize());

    let mut is_ca = false;
    let mut ocsp_url = None;
    let mut crl_urls = Vec::new();

    for ext in cert.extensions() {
        match ext.parsed_extension() {
            ParsedExtension::BasicConstraints(bc) => {
                is_ca = bc.ca;
            }
            ParsedExtension::AuthorityInfoAccess(aia) => {
                for access in &aia.accessdescs {
                    // 1.3.6.1.5.5.7.48.1 is id-ad-ocsp
                    let oid_str = access.access_method.to_string();
                    if oid_str == "1.3.6.1.5.5.7.48.1" {
                        if let GeneralName::URI(uri) = &access.access_location {
                            ocsp_url = Some(uri.to_string());
                        }
                    }
                }
            }
            ParsedExtension::CRLDistributionPoints(cdp) => {
                for dp in &cdp.points {
                    if let Some(name) = &dp.distribution_point {
                        match name {
                            x509_parser::extensions::DistributionPointName::FullName(names) => {
                                for n in names {
                                    if let GeneralName::URI(uri) = n {
                                        crl_urls.push(uri.to_string());
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
            _ => {}
        }
    }

    Ok(CertInfo {
        subject: subject_dn,
        issuer: issuer_dn,
        serial_hex,
        not_before,
        not_after,
        sha256_fingerprint,
        is_ca,
        ocsp_url,
        crl_urls,
        der: der_bytes.to_vec(),
    })
}

pub fn parse_certs_pem(pem_str: &str) -> Result<Vec<CertInfo>> {
    let mut certs = Vec::new();
    for item in Pem::iter_from_buffer(pem_str.as_bytes()) {
        let pem = item.map_err(|e| anyhow!("Failed to parse PEM item: {:?}", e))?;
        if pem.label == "CERTIFICATE" {
            let cert_info = parse_cert_der(&pem.contents)?;
            certs.push(cert_info);
        }
    }
    Ok(certs)
}

pub fn cert_common_name(cert_info: &CertInfo) -> String {
    // Look for CN=... in the subject string
    for part in cert_info.subject.split(',') {
        let trimmed = part.trim();
        if let Some(cn) = trimmed.strip_prefix("CN=") {
            return cn.to_string();
        }
    }
    // Fallback to Organization or Subject
    for part in cert_info.subject.split(',') {
        let trimmed = part.trim();
        if let Some(o) = trimmed.strip_prefix("O=") {
            return o.to_string();
        }
    }
    cert_info.subject.clone()
}
