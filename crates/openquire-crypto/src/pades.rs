//! PAdES (PDF Advanced Electronic Signatures) and CMS / PKCS#7 detached signatures.

use crate::p12::DigitalId;
use crate::pki::{cert_common_name, parse_cert_der, CertInfo};
use anyhow::{anyhow, Result};
use chrono::{DateTime, Datelike, Utc};
use rsa::pkcs1v15::SigningKey;
use rsa::signature::{SignatureEncoding, Signer, Verifier};
use rsa::pkcs8::DecodePublicKey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use x509_parser::prelude::*;
use yasna::models::ObjectIdentifier;

// Standard OIDs
const OID_PKCS7_SIGNED_DATA: &[u64] = &[1, 2, 840, 113549, 1, 7, 2];
const OID_PKCS7_DATA: &[u64] = &[1, 2, 840, 113549, 1, 7, 1];
const OID_SHA256: &[u64] = &[2, 16, 840, 1, 101, 3, 4, 2, 1];
const OID_RSA_ENCRYPTION: &[u64] = &[1, 2, 840, 113549, 1, 1, 1];
const OID_CONTENT_TYPE: &[u64] = &[1, 2, 840, 113549, 1, 9, 3];
const OID_MESSAGE_DIGEST: &[u64] = &[1, 2, 840, 113549, 1, 9, 4];
const OID_SIGNING_TIME: &[u64] = &[1, 2, 840, 113549, 1, 9, 5];
const OID_SIGNING_CERT_V2: &[u64] = &[1, 2, 840, 113549, 1, 9, 16, 2, 47];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignatureVerificationResult {
    pub signer: String,
    pub signing_time: Option<DateTime<Utc>>,
    pub valid_signature: bool,
    pub valid_digest: bool,
    pub chain: Vec<CertInfo>,
}

#[derive(Debug, Clone)]
pub struct SignOptions<'a> {
    pub digital_id: &'a DigitalId,
    pub content_digest: [u8; 32],
    pub signing_time: Option<DateTime<Utc>>,
}

/// Constructs a DER-encoded Attribute.
fn encode_attribute(oid: &[u64], values_der: Vec<Vec<u8>>) -> Vec<u8> {
    yasna::construct_der(|writer| {
        writer.write_sequence(|writer| {
            writer.next().write_oid(&ObjectIdentifier::from_slice(oid));
            writer.next().write_set(|writer| {
                for val in values_der {
                    writer.next().write_der(&val);
                }
            });
        });
    })
}

/// Builds and canonically sorts the DER SignedAttributes for PAdES.
pub fn build_signed_attributes(content_digest: &[u8; 32], cert_der: &[u8], signing_time: DateTime<Utc>) -> Vec<u8> {
    let mut attrs: Vec<Vec<u8>> = Vec::new();

    // 1. ContentType: id-data
    let content_type_val = yasna::construct_der(|writer| {
        writer.write_oid(&ObjectIdentifier::from_slice(OID_PKCS7_DATA));
    });
    attrs.push(encode_attribute(OID_CONTENT_TYPE, vec![content_type_val]));

    // 2. MessageDigest: SHA-256 of document content
    let message_digest_val = yasna::construct_der(|writer| {
        writer.write_bytes(content_digest);
    });
    attrs.push(encode_attribute(OID_MESSAGE_DIGEST, vec![message_digest_val]));

    // 3. SigningTime: UTC time string
    let (tag, time_str) = if (1950..2050).contains(&signing_time.year()) {
        (0x17, signing_time.format("%y%m%d%H%M%SZ").to_string())
    } else {
        (0x18, signing_time.format("%Y%m%d%H%M%SZ").to_string())
    };
    let signing_time_val = yasna::construct_der(|writer| {
        let mut encoded = vec![tag, time_str.len() as u8];
        encoded.extend_from_slice(time_str.as_bytes());
        writer.write_der(&encoded);
    });
    attrs.push(encode_attribute(OID_SIGNING_TIME, vec![signing_time_val]));

    // 4. SigningCertificateV2 (ESSCertIDv2) for PAdES
    let cert_sha256 = {
        let mut hasher = Sha256::new();
        hasher.update(cert_der);
        hasher.finalize()
    };
    let ess_cert_v2_val = yasna::construct_der(|writer| {
        writer.write_sequence(|writer| {
            // SEQUENCE OF ESSCertIDv2
            writer.next().write_sequence(|writer| {
                // ESSCertIDv2
                writer.next().write_sequence(|writer| {
                    // certHash Hash (SHA-256)
                    writer.next().write_bytes(&cert_sha256);
                });
            });
        });
    });
    attrs.push(encode_attribute(OID_SIGNING_CERT_V2, vec![ess_cert_v2_val]));

    // ITU-T X.690 Section 11.6: The encodings of the component values of a SET OF type
    // shall appear in ascending order based on their tag and length octets and value octets.
    attrs.sort();

    // Serialize as a SET OF (tag 0x31)
    yasna::construct_der(|writer| {
        writer.write_set(|writer| {
            for attr in attrs {
                writer.next().write_der(&attr);
            }
        });
    })
}

/// Generates a detached CMS / PKCS#7 signature in DER format for PDF signing.
pub fn create_pades_cms_signature(opts: &SignOptions) -> Result<Vec<u8>> {
    let key = opts
        .digital_id
        .key
        .as_ref()
        .ok_or_else(|| anyhow!("DigitalId private key is missing"))?;
    let signer_cert = opts
        .digital_id
        .chain
        .first()
        .ok_or_else(|| anyhow!("DigitalId certificate chain is empty"))?;

    let signing_time = opts.signing_time.unwrap_or_else(Utc::now);

    // 1. Build SignedAttributes
    let signed_attrs_der = build_signed_attributes(&opts.content_digest, &signer_cert.der, signing_time);

    // 2. Compute RSA signature over the DER-encoded SignedAttributes
    let signing_key = SigningKey::<Sha256>::new(key.clone());
    let signature_bytes = signing_key.sign(&signed_attrs_der).to_vec();

    // 3. Parse Issuer and SerialNumber from the signer's certificate DER
    let (_, x509_cert) = parse_x509_certificate(&signer_cert.der)
        .map_err(|e| anyhow!("Failed to parse signer certificate: {:?}", e))?;
    let serial_bytes = x509_cert.serial.to_bytes_be();
    let issuer_raw = x509_cert.issuer().as_raw();

    // 4. Construct complete CMS SignedData
    let cms_der = yasna::construct_der(|writer| {
        writer.write_sequence(|writer| {
            // ContentInfo.contentType = signedData
            writer.next().write_oid(&ObjectIdentifier::from_slice(OID_PKCS7_SIGNED_DATA));

            // ContentInfo.content = [0] EXPLICIT SignedData
            writer.next().write_tagged(yasna::Tag::context(0), |writer| {
                writer.write_sequence(|writer| {
                    // version: 1
                    writer.next().write_u8(1);

                    // digestAlgorithms: SET OF DigestAlgorithmIdentifier
                    writer.next().write_set(|writer| {
                        writer.next().write_sequence(|writer| {
                            writer.next().write_oid(&ObjectIdentifier::from_slice(OID_SHA256));
                            writer.next().write_null();
                        });
                    });

                    // encapContentInfo: EncapsulatedContentInfo (detached: eContent is omitted)
                    writer.next().write_sequence(|writer| {
                        writer.next().write_oid(&ObjectIdentifier::from_slice(OID_PKCS7_DATA));
                    });

                    // certificates: [0] IMPLICIT CertificateSet
                    writer.next().write_tagged_implicit(yasna::Tag::context(0), |writer| {
                        writer.write_set(|writer| {
                            for cert in &opts.digital_id.chain {
                                writer.next().write_der(&cert.der);
                            }
                        });
                    });

                    // signerInfos: SignerInfos
                    writer.next().write_set(|writer| {
                        writer.next().write_sequence(|writer| {
                            // version: 1
                            writer.next().write_u8(1);

                            // sid: IssuerAndSerialNumber
                            writer.next().write_sequence(|writer| {
                                writer.next().write_der(issuer_raw);
                                writer.next().write_bigint_bytes(&serial_bytes, true);
                            });

                            // digestAlgorithm: sha256
                            writer.next().write_sequence(|writer| {
                                writer.next().write_oid(&ObjectIdentifier::from_slice(OID_SHA256));
                                writer.next().write_null();
                            });

                            // signedAttrs: [0] IMPLICIT SignedAttributes
                            // write_der copies bytes verbatim, so apply the implicit
                            // context tag explicitly while preserving length/body.
                            let mut tagged_attrs = signed_attrs_der.clone();
                            tagged_attrs[0] = 0xa0;
                            writer.next().write_der(&tagged_attrs);

                            // signatureAlgorithm: rsaEncryption
                            writer.next().write_sequence(|writer| {
                                writer.next().write_oid(&ObjectIdentifier::from_slice(OID_RSA_ENCRYPTION));
                                writer.next().write_null();
                            });

                            // signature: OCTET STRING
                            writer.next().write_bytes(&signature_bytes);
                        });
                    });
                });
            });
        });
    });

    // A mismatched certificate/private key must never produce a reported success.
    let verified = verify_cms_signature(&cms_der, &opts.content_digest)?;
    if !verified.valid_signature || !verified.valid_digest {
        return Err(anyhow!("Generated CMS signature failed verification"));
    }
    Ok(cms_der)
}

// A bounded DER reader for the supported detached, single-signer RSA/SHA-256
// profile. Unsupported structures fail closed rather than becoming a success.
#[derive(Clone, Copy)]
struct Der<'a> { tag: u8, full: &'a [u8], body: &'a [u8] }

fn der(input: &[u8]) -> Result<(Der<'_>, &[u8])> {
    if input.len() < 2 || input[0] & 0x1f == 0x1f { return Err(anyhow!("Invalid DER tag")); }
    let first = input[1];
    let (header, length) = if first < 128 { (2, first as usize) } else {
        let n = (first & 127) as usize;
        if n == 0 || n > std::mem::size_of::<usize>() || input.len() < 2 + n || input[2] == 0 {
            return Err(anyhow!("Invalid DER length"));
        }
        let mut length = 0usize;
        for b in &input[2..2+n] {
            length = length.checked_mul(256).and_then(|v| v.checked_add(*b as usize))
                .ok_or_else(|| anyhow!("DER length overflow"))?;
        }
        if length < 128 { return Err(anyhow!("Noncanonical DER length")); }
        (2 + n, length)
    };
    let end = header.checked_add(length).filter(|end| *end <= input.len())
        .ok_or_else(|| anyhow!("Truncated DER"))?;
    Ok((Der { tag: input[0], full: &input[..end], body: &input[header..end] }, &input[end..]))
}

fn children(value: Der<'_>, tag: u8) -> Result<Vec<Der<'_>>> {
    if value.tag != tag { return Err(anyhow!("Unexpected DER tag")); }
    let mut out = Vec::new();
    let mut remaining = value.body;
    while !remaining.is_empty() {
        let (item, rest) = der(remaining)?;
        out.push(item);
        remaining = rest;
    }
    Ok(out)
}

fn oid(value: Der<'_>, expected: &[u64]) -> bool {
    value.full == yasna::construct_der(|w| w.write_oid(&ObjectIdentifier::from_slice(expected)))
}

fn algorithm(value: Der<'_>, expected: &[u64]) -> Result<()> {
    let fields = children(value, 0x30)?;
    if fields.is_empty() || fields.len() > 2 || !oid(fields[0], expected)
        || (fields.len() == 2 && fields[1].full != [0x05, 0x00]) {
        return Err(anyhow!("Unsupported CMS algorithm"));
    }
    Ok(())
}

fn unsigned_integer(bytes: &[u8]) -> &[u8] {
    let start = bytes.iter().position(|b| *b != 0).unwrap_or(bytes.len());
    &bytes[start..]
}

/// Verify detached, single-signer RSA/SHA-256 CMS integrity. This does not
/// establish certificate trust, revocation status or a trusted signing time.
pub fn verify_cms_signature(cms_der: &[u8], actual_content_digest: &[u8; 32]) -> Result<SignatureVerificationResult> {
    let (root, padding) = der(cms_der)?;
    // PDF Contents often reserves more space than the DER value needs.
    if padding.iter().any(|b| *b != 0) { return Err(anyhow!("Trailing CMS data")); }
    let outer = children(root, 0x30)?;
    if outer.len() != 2 || !oid(outer[0], OID_PKCS7_SIGNED_DATA) {
        return Err(anyhow!("Expected CMS SignedData"));
    }
    let explicit = children(outer[1], 0xa0)?;
    if explicit.len() != 1 { return Err(anyhow!("Invalid SignedData wrapper")); }
    let sd = children(explicit[0], 0x30)?;
    if sd.len() != 5 || sd[0].full != [0x02, 0x01, 0x01] {
        return Err(anyhow!("Unsupported SignedData structure"));
    }
    let algorithms = children(sd[1], 0x31)?;
    if algorithms.len() != 1 { return Err(anyhow!("Expected one digest algorithm")); }
    algorithm(algorithms[0], OID_SHA256)?;
    let content = children(sd[2], 0x30)?;
    if content.len() != 1 || !oid(content[0], OID_PKCS7_DATA) {
        return Err(anyhow!("Expected detached CMS data"));
    }
    let certs = children(sd[3], 0xa0)?;
    let signers = children(sd[4], 0x31)?;
    if signers.len() != 1 { return Err(anyhow!("Expected one signer")); }
    let si = children(signers[0], 0x30)?;
    if si.len() != 6 || si[0].full != [0x02, 0x01, 0x01] || si[5].tag != 0x04 {
        return Err(anyhow!("Unsupported SignerInfo"));
    }
    algorithm(si[2], OID_SHA256)?;
    algorithm(si[4], OID_RSA_ENCRYPTION)?;
    let sid = children(si[1], 0x30)?;
    if sid.len() != 2 || sid[0].tag != 0x30 || sid[1].tag != 0x02 || sid[1].body.is_empty()
        || sid[1].body[0] & 0x80 != 0 {
        return Err(anyhow!("Invalid signer identifier"));
    }
    let mut signer_der = None;
    for cert in &certs {
        let (rest, parsed) = parse_x509_certificate(cert.full).map_err(|_| anyhow!("Invalid CMS certificate"))?;
        if !rest.is_empty() { return Err(anyhow!("Trailing certificate data")); }
        if parsed.issuer().as_raw() == sid[0].full
            && unsigned_integer(parsed.raw_serial()) == unsigned_integer(sid[1].body) {
            if signer_der.replace(cert.full).is_some() { return Err(anyhow!("Ambiguous signer certificate")); }
        }
    }
    let signer_der = signer_der.ok_or_else(|| anyhow!("Signer certificate missing"))?;
    let attrs = children(si[3], 0xa0)?;
    if attrs.windows(2).any(|a| a[0].full > a[1].full) { return Err(anyhow!("Noncanonical signed attributes")); }
    let mut message_digest = None;
    let mut content_type_seen = false;
    let mut seen = std::collections::HashSet::new();
    for attr in attrs {
        let fields = children(attr, 0x30)?;
        if fields.len() != 2 || fields[0].tag != 0x06 || !seen.insert(fields[0].full) {
            return Err(anyhow!("Invalid or duplicate signed attribute"));
        }
        let values = children(fields[1], 0x31)?;
        if oid(fields[0], OID_MESSAGE_DIGEST) {
            if values.len() != 1 || values[0].tag != 0x04 || values[0].body.len() != 32 {
                return Err(anyhow!("Invalid message digest"));
            }
            message_digest = Some(values[0].body);
        } else if oid(fields[0], OID_CONTENT_TYPE) {
            if values.len() != 1 || !oid(values[0], OID_PKCS7_DATA) {
                return Err(anyhow!("Invalid content type"));
            }
            content_type_seen = true;
        }
    }
    if !content_type_seen { return Err(anyhow!("Missing content type")); }
    let digest = message_digest.ok_or_else(|| anyhow!("Missing message digest"))?;
    let (_, parsed) = parse_x509_certificate(signer_der).map_err(|_| anyhow!("Invalid signer certificate"))?;
    let key = rsa::RsaPublicKey::from_public_key_der(parsed.public_key().raw)
        .map_err(|_| anyhow!("Unsupported signer key"))?;
    let signature = rsa::pkcs1v15::Signature::try_from(si[5].body)
        .map_err(|_| anyhow!("Invalid RSA signature"))?;
    let mut signed = si[3].full.to_vec();
    signed[0] = 0x31; // Signature covers the DER SET, not its implicit context tag.
    let valid_signature = rsa::pkcs1v15::VerifyingKey::<Sha256>::new(key).verify(&signed, &signature).is_ok();
    let signer = parse_cert_der(signer_der)?;
    let mut chain = vec![signer.clone()];
    for cert in certs {
        if cert.full != signer_der { chain.push(parse_cert_der(cert.full)?); }
    }
    Ok(SignatureVerificationResult {
        signer: cert_common_name(&signer), signing_time: None,
        valid_signature, valid_digest: digest == actual_content_digest, chain,
    })
}

