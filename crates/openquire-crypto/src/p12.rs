//! PKCS#12 (.p12/.pfx) digital ID generation and reading.

use crate::pki::{cert_common_name, parse_cert_der, CertInfo};
use anyhow::{anyhow, Result};
use p12::PFX;
use rcgen::{CertificateParams, DnType, IsCa, KeyPair, KeyUsagePurpose};
use rsa::pkcs1::DecodeRsaPrivateKey as DecodePkcs1;
use rsa::pkcs8::DecodePrivateKey as DecodePkcs8;
use rsa::RsaPrivateKey;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone)]
pub struct DigitalId {
    pub key: Option<RsaPrivateKey>,
    pub chain: Vec<CertInfo>,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateDigitalIdOptions {
    pub name: String,
    pub email: Option<String>,
    pub organization: Option<String>,
    pub password: String,
    pub years: Option<u32>,
}

/// Creates a self-signed digital ID and returns it as a password-protected PKCS#12 (.p12) buffer.
pub fn create_digital_id(opts: &CreateDigitalIdOptions) -> Result<Vec<u8>> {
    let mut params = CertificateParams::default();
    params.distinguished_name.push(DnType::CommonName, &opts.name);
    if let Some(org) = &opts.organization {
        params.distinguished_name.push(DnType::OrganizationName, org);
    }

    params.is_ca = IsCa::NoCa;
    params.key_usages = vec![
        KeyUsagePurpose::DigitalSignature,
        KeyUsagePurpose::ContentCommitment, // nonRepudiation
    ];

    let years = opts.years.unwrap_or(5);
    let not_before = time::OffsetDateTime::now_utc();
    let not_after = not_before + time::Duration::days((years as i64) * 365);
    params.not_before = not_before;
    params.not_after = not_after;

    use rsa::pkcs8::EncodePrivateKey;
    let mut rng = rand::thread_rng();
    let rsa_key = RsaPrivateKey::new(&mut rng, 2048)
        .map_err(|e| anyhow!("Failed to generate RSA key pair: {}", e))?;
    let pkcs8_der = rsa_key.to_pkcs8_der()
        .map_err(|e| anyhow!("Failed to encode PKCS#8 key: {}", e))?;
    let key_pair = KeyPair::try_from(pkcs8_der.as_bytes())
        .map_err(|e| anyhow!("Failed to load KeyPair from PKCS#8: {}", e))?;
    let cert = params
        .self_signed(&key_pair)
        .map_err(|e| anyhow!("Failed to self-sign certificate: {}", e))?;

    let cert_der = cert.der().to_vec();
    let key_der = pkcs8_der.as_bytes().to_vec();

    let pfx = PFX::new(&cert_der, &key_der, None, &opts.password, &opts.name)
        .ok_or_else(|| anyhow!("Failed to create PKCS#12 archive"))?;

    Ok(pfx.to_der())
}

/// Reads a .p12 / .pfx digital ID, extracting the RSA private key and certificate chain.
pub fn read_digital_id(p12_bytes: &[u8], password: &str) -> Result<DigitalId> {
    let pfx = PFX::parse(p12_bytes)
        .map_err(|e| anyhow!("Couldn't open the digital ID. Check the file and format: {:?}", e))?;

    if !pfx.verify_mac(password) {
        return Err(anyhow!("Couldn't open the digital ID. Check the password."));
    }

    let key_bags = pfx
        .key_bags(password)
        .map_err(|e| anyhow!("Failed to decrypt private key from digital ID: {:?}", e))?;

    let key_der = key_bags
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("This digital ID has no private key."))?;

    // Try parsing as PKCS#8 or PKCS#1 RSA private key
    let rsa_key = RsaPrivateKey::from_pkcs8_der(&key_der)
        .or_else(|_| RsaPrivateKey::from_pkcs1_der(&key_der))
        .map_err(|e| anyhow!("Failed to parse RSA private key: {}", e))?;

    let cert_bags = pfx
        .cert_x509_bags(password)
        .map_err(|e| anyhow!("Failed to extract certificates from digital ID: {:?}", e))?;

    if cert_bags.is_empty() {
        return Err(anyhow!("This digital ID has no certificates."));
    }

    let mut chain = Vec::new();
    for der in cert_bags {
        let cert_info = parse_cert_der(&der)?;
        chain.push(cert_info);
    }

    let name = chain
        .first()
        .map(cert_common_name)
        .unwrap_or_else(|| "Unknown".to_string());

    Ok(DigitalId {
        key: Some(rsa_key),
        chain,
        name,
    })
}
