use openquire_crypto::{
    create_digital_id, create_pades_cms_signature, read_digital_id, verify_cms_signature,
    CreateDigitalIdOptions, SignOptions, TrustStore,
};
use sha2::{Digest, Sha256};

#[test]
fn test_create_and_read_digital_id() {
    let opts = CreateDigitalIdOptions {
        name: "Alice Doe".to_string(),
        email: Some("alice@example.com".to_string()),
        organization: Some("Acme Corp".to_string()),
        password: "secretpassword123".to_string(),
        years: Some(2),
    };

    let p12_bytes = create_digital_id(&opts).expect("Should create digital ID");
    assert!(!p12_bytes.is_empty());

    // Reading with correct password
    let id = read_digital_id(&p12_bytes, "secretpassword123").expect("Should read digital ID");
    assert_eq!(id.name, "Alice Doe");
    assert!(id.key.is_some());
    assert_eq!(id.chain.len(), 1);
    assert!(id.chain[0].subject.contains("Alice Doe"));

    // Reading with wrong password fails
    assert!(read_digital_id(&p12_bytes, "wrongpassword").is_err());
}

#[test]
fn test_pades_cms_signing_and_verification() {
    let opts = CreateDigitalIdOptions {
        name: "Signer Person".to_string(),
        email: None,
        organization: Some("Security Ltd".to_string()),
        password: "p12password".to_string(),
        years: Some(1),
    };
    let p12_bytes = create_digital_id(&opts).unwrap();
    let digital_id = read_digital_id(&p12_bytes, "p12password").unwrap();

    let document_bytes = b"Hello, PDF document byte range content to sign!";
    let mut hasher = Sha256::new();
    hasher.update(document_bytes);
    let digest: [u8; 32] = hasher.finalize().into();

    let sign_opts = SignOptions {
        digital_id: &digital_id,
        content_digest: digest,
        signing_time: None,
    };

    let cms_signature = create_pades_cms_signature(&sign_opts).expect("Should create CMS signature");
    assert!(!cms_signature.is_empty());

    let verification = verify_cms_signature(&cms_signature, &digest).expect("Should verify signature");
    assert_eq!(verification.signer, "Signer Person");
    assert!(verification.valid_signature);
    assert!(verification.valid_digest);
    assert_eq!(verification.chain.len(), 1);

    let mut wrong_digest = digest;
    wrong_digest[0] ^= 1;
    let wrong_content = verify_cms_signature(&cms_signature, &wrong_digest).unwrap();
    assert!(!wrong_content.valid_digest);

    let mut forged = cms_signature.clone();
    *forged.last_mut().unwrap() ^= 1;
    assert!(!verify_cms_signature(&forged, &digest).unwrap().valid_signature);

    for length in [0, 1, cms_signature.len() / 2, cms_signature.len() - 1] {
        assert!(verify_cms_signature(&cms_signature[..length], &digest).is_err());
    }
    let mut mismatched = read_digital_id(&p12_bytes, "p12password").unwrap();
    mismatched.key = Some(rsa::RsaPrivateKey::new(&mut rand::thread_rng(), 2048).unwrap());
    assert!(create_pades_cms_signature(&SignOptions {
        digital_id: &mismatched, content_digest: digest, signing_time: None,
    }).is_err());
}

#[test]
fn test_bundled_trust_store() {
    let trust_store = TrustStore::load_bundled().expect("Should load bundled roots");
    // Verify an untrusted self-signed certificate is marked as not trusted
    let opts = CreateDigitalIdOptions {
        name: "Untrusted Root".to_string(),
        email: None,
        organization: None,
        password: "pass".to_string(),
        years: Some(1),
    };
    let p12_bytes = create_digital_id(&opts).unwrap();
    let digital_id = read_digital_id(&p12_bytes, "pass").unwrap();

    let report = trust_store.verify_chain(&digital_id.chain);
    assert!(!report.trusted);
    assert!(!report.issues.is_empty());
}

