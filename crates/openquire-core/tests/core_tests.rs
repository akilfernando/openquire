use lopdf::content::{Content, Operation};
use lopdf::{Dictionary, Document, Object, StringFormat};
use openquire_core::{
    resolve_pattern, Metadata, PdfDocument, StampPosition, StampSpec,
};
use openquire_crypto::{create_digital_id, verify_cms_signature, CreateDigitalIdOptions};
use sha2::{Digest, Sha256};
use regex::Regex;

/// Helper to generate a minimal valid 1-page PDF document in memory.
fn create_test_pdf(text: &str) -> Vec<u8> {
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();

    let mut font_dict = Dictionary::new();
    font_dict.set("Type", "Font");
    font_dict.set("Subtype", "Type1");
    font_dict.set("BaseFont", "Helvetica");
    let font_id = doc.add_object(Object::Dictionary(font_dict));

    let content_ops = vec![
        Operation::new("BT", vec![]),
        Operation::new("Tf", vec![Object::Name(b"F1".to_vec()), Object::Real(12.0)]),
        Operation::new("Td", vec![Object::Real(50.0), Object::Real(700.0)]),
        Operation::new("Tj", vec![Object::String(text.as_bytes().to_vec(), StringFormat::Literal)]),
        Operation::new("ET", vec![]),
    ];
    let content = Content { operations: content_ops };
    let content_bytes = content.encode().unwrap();
    let stream_id = doc.add_object(Object::Stream(lopdf::Stream::new(Dictionary::new(), content_bytes)));

    let mut fonts = Dictionary::new();
    fonts.set("F1", Object::Reference(font_id));
    let mut resources = Dictionary::new();
    resources.set("Font", Object::Dictionary(fonts));

    let mut page_dict = Dictionary::new();
    page_dict.set("Type", "Page");
    page_dict.set("Parent", Object::Reference(pages_id));
    page_dict.set("MediaBox", vec![0.into(), 0.into(), 595.into(), 842.into()]);
    page_dict.set("Contents", Object::Reference(stream_id));
    page_dict.set("Resources", Object::Dictionary(resources));
    let page_id = doc.add_object(Object::Dictionary(page_dict));

    let mut pages_dict = Dictionary::new();
    pages_dict.set("Type", "Pages");
    pages_dict.set("Kids", vec![Object::Reference(page_id)]);
    pages_dict.set("Count", 1);
    doc.objects.insert(pages_id, Object::Dictionary(pages_dict));

    let mut catalog = Dictionary::new();
    catalog.set("Type", "Catalog");
    catalog.set("Pages", Object::Reference(pages_id));
    let catalog_id = doc.add_object(Object::Dictionary(catalog));
    doc.trailer.set("Root", Object::Reference(catalog_id));

    let mut out = Vec::new();
    doc.save_to(&mut out).unwrap();
    out
}

#[test]
fn test_pdf_open_and_info() {
    let bytes = create_test_pdf("Hello OpenQuire Rust!");
    let pdf = PdfDocument::open("test.pdf".to_string(), &bytes).expect("Should open PDF");
    assert_eq!(pdf.page_count(), 1);
    assert!(!pdf.is_encrypted());
}

#[test]
fn test_metadata_roundtrip() {
    let bytes = create_test_pdf("Sample Text");
    let mut pdf = PdfDocument::open("meta.pdf".to_string(), &bytes).unwrap();

    let meta = Metadata {
        title: Some("Project Specification".to_string()),
        author: Some("Akil Fernando".to_string()),
        subject: Some("Rust Migration".to_string()),
        keywords: Some("rust, pdf, openquire".to_string()),
        ..Default::default()
    };
    pdf.set_metadata(&meta);

    let saved = pdf.save().unwrap();
    let reloaded = PdfDocument::open("meta_saved.pdf".to_string(), &saved).unwrap();
    let reloaded_meta = reloaded.get_metadata();

    assert_eq!(reloaded_meta.title.as_deref(), Some("Project Specification"));
    assert_eq!(reloaded_meta.author.as_deref(), Some("Akil Fernando"));
    assert_eq!(reloaded_meta.subject.as_deref(), Some("Rust Migration"));
    assert_eq!(reloaded_meta.keywords.as_deref(), Some("rust, pdf, openquire"));
}

#[test]
fn test_redact_patterns_and_terms() {
    let bytes = create_test_pdf("Contact us at test.user@example.com for confidential details.");
    let mut pdf = PdfDocument::open("confidential.pdf".to_string(), &bytes).unwrap();

    let pattern = resolve_pattern("email");
    let regex = Regex::new(pattern).unwrap();
    let before = pdf.save().unwrap();
    assert!(pdf.redact(&[regex], &["confidential".to_string()]).is_err());
    assert_eq!(pdf.save().unwrap(), before);

}

#[test]
fn test_bates_stamping() {
    let bytes = create_test_pdf("Page Content");
    let mut pdf = PdfDocument::open("doc.pdf".to_string(), &bytes).unwrap();

    let spec = StampSpec {
        template: "ACME-{bates}".to_string(),
        position: StampPosition::Br,
        size: 10.0,
        bates_start: Some(100),
        bates_digits: Some(6),
    };

    let mut bates = 100;
    pdf.stamp(&spec, &mut bates).expect("Should stamp page");
    assert_eq!(bates, 101);

    let saved = pdf.save().unwrap();
    let reloaded = PdfDocument::open("stamped.pdf".to_string(), &saved).unwrap();
    let text = reloaded.extract_text();
    assert!(text.contains("ACME-000100"));
}

#[test]
fn test_digital_signing() {
    let bytes = create_test_pdf("Document to be digitally certified and signed.");
    let mut pdf = PdfDocument::open("tosign.pdf".to_string(), &bytes).unwrap();

    let opts = CreateDigitalIdOptions {
        name: "Verified Signer".to_string(),
        email: Some("signer@openquire.dev".to_string()),
        organization: Some("OpenQuire Trust".to_string()),
        password: "signpass".to_string(),
        years: Some(1),
    };
    let p12_bytes = create_digital_id(&opts).unwrap();

    let original = pdf.save().unwrap();
    let signed_bytes = pdf.sign(&p12_bytes, "signpass", Some("Approval"), Some("Office")).unwrap();
    assert!(!signed_bytes.is_empty());
    assert!(signed_bytes.len() > bytes.len());
    assert_eq!(pdf.save().unwrap(), original);
    let parsed = Document::load_mem(&signed_bytes).unwrap();
    let signature = parsed.objects.values().filter_map(|o| o.as_dict().ok())
        .find(|d| d.has(b"ByteRange")).unwrap();
    let ranges: Vec<usize> = signature.get(b"ByteRange").unwrap().as_array().unwrap().iter()
        .map(|v| v.as_i64().unwrap() as usize).collect();
    assert_eq!(ranges.len(), 4);
    assert_eq!(ranges[0], 0);
    assert!(ranges[1] < ranges[2]);
    assert_eq!(ranges[2] + ranges[3], signed_bytes.len());
    let mut digest = Sha256::new();
    digest.update(&signed_bytes[..ranges[1]]);
    digest.update(&signed_bytes[ranges[2]..]);
    let digest: [u8; 32] = digest.finalize().into();
    let cms = signature.get(b"Contents").unwrap().as_str().unwrap();
    let report = verify_cms_signature(cms, &digest).unwrap();
    assert!(report.valid_signature && report.valid_digest);
    let mut signed = PdfDocument::open("signed.pdf".to_string(), &signed_bytes).unwrap();
    assert!(signed.sign(&p12_bytes, "signpass", None, None).is_err());
}

