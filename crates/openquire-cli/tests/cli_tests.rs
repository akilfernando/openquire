use openquire_core::PdfDocument;
use openquire_crypto::{create_digital_id, CreateDigitalIdOptions};
use std::fs;
use std::process::Command;
use tempfile::tempdir;

fn binary_path() -> std::path::PathBuf {
    // Cargo supplies the binary built for this test invocation, including .exe on Windows.
    std::path::PathBuf::from(env!("CARGO_BIN_EXE_openquire"))
}

fn create_pdf(text: &str) -> Vec<u8> {
    use lopdf::content::{Content, Operation};
    use lopdf::{Dictionary, Document, Object, StringFormat};

    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();

    let mut font_dict = Dictionary::new();
    font_dict.set("Type", "Font");
    font_dict.set("Subtype", "Type1");
    font_dict.set("BaseFont", "Helvetica");
    font_dict.set("Encoding", "WinAnsiEncoding");
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
fn test_cli_help_and_errors() {
    let bin = binary_path();

    let help = Command::new(&bin).arg("--help").output().unwrap();
    assert_eq!(help.status.code(), Some(0));
    let stdout = String::from_utf8_lossy(&help.stdout);
    assert!(stdout.contains("openquire <command>"));

    let unknown = Command::new(&bin).args(["frobnicate", "x.pdf"]).output().unwrap();
    assert_eq!(unknown.status.code(), Some(2));

    let missing = Command::new(&bin).args(["redact", "--pattern", "email", "missing_folder_test"]).output().unwrap();
    assert_eq!(missing.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&missing.stderr).contains("No such file or folder"));
}

#[test]
fn test_cli_redact_folder() {
    let bin = binary_path();
    let dir = tempdir().unwrap();

    let a_pdf = dir.path().join("a.pdf");
    let b_pdf = dir.path().join("b.pdf");
    fs::write(&a_pdf, create_pdf("Contact jane.doe@example.com today.")).unwrap();
    fs::write(&b_pdf, create_pdf("No personal information.")).unwrap();

    let out_dir = dir.path().join("out");
    let output = Command::new(&bin)
        .args(["redact", "--pattern", "email", dir.path().to_str().unwrap(), "-o", out_dir.to_str().unwrap()])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(0));
    assert!(out_dir.join("a.pdf").exists());
    assert!(out_dir.join("b.pdf").exists());

    let a_bytes = fs::read(out_dir.join("a.pdf")).unwrap();
    let doc = PdfDocument::open("a.pdf".to_string(), &a_bytes).unwrap();
    let text = doc.extract_text();
    assert!(!text.contains("jane.doe@example.com"));
    assert!(text.contains("Contact"));
}

#[test]
fn test_cli_bates_stamping() {
    let bin = binary_path();
    let dir = tempdir().unwrap();

    let doc_pdf = dir.path().join("doc.pdf");
    fs::write(&doc_pdf, create_pdf("First document page")).unwrap();

    let out_dir = dir.path().join("stamped_out");
    let output = Command::new(&bin)
        .args([
            "stamp",
            doc_pdf.to_str().unwrap(),
            "--text",
            "ACME-{bates}",
            "--position",
            "br",
            "--bates-start",
            "500",
            "-o",
            out_dir.to_str().unwrap(),
        ])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(0));
    let stamped_file = out_dir.join("doc.pdf");
    assert!(stamped_file.exists());

    let bytes = fs::read(stamped_file).unwrap();
    let doc = PdfDocument::open("doc.pdf".to_string(), &bytes).unwrap();
    assert!(doc.extract_text().contains("ACME-000500"));
}

#[test]
fn test_cli_merge() {
    let bin = binary_path();
    let dir = tempdir().unwrap();

    let f1 = dir.path().join("1.pdf");
    let f2 = dir.path().join("2.pdf");
    fs::write(&f1, create_pdf("File 1 content")).unwrap();
    fs::write(&f2, create_pdf("File 2 content")).unwrap();

    let merged_file = dir.path().join("merged.pdf");
    let output = Command::new(&bin)
        .args([
            "merge",
            f1.to_str().unwrap(),
            f2.to_str().unwrap(),
            "-o",
            merged_file.to_str().unwrap(),
        ])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(0));
    assert!(merged_file.exists());
    let bytes = fs::read(merged_file).unwrap();
    let doc = PdfDocument::open("merged.pdf".to_string(), &bytes).unwrap();
    assert_eq!(doc.page_count(), 2);
}

#[test]
fn test_cli_sign() {
    let bin = binary_path();
    let dir = tempdir().unwrap();

    let id_opts = CreateDigitalIdOptions {
        name: "Test Signer".to_string(),
        email: None,
        organization: None,
        password: "secret".to_string(),
        years: Some(1),
    };
    let p12_bytes = create_digital_id(&id_opts).unwrap();
    let p12_path = dir.path().join("id.p12");
    fs::write(&p12_path, p12_bytes).unwrap();

    let doc_path = dir.path().join("contract.pdf");
    fs::write(&doc_path, create_pdf("Contract to sign")).unwrap();

    let output = Command::new(&bin)
        .args([
            "sign",
            doc_path.to_str().unwrap(),
            "--p12",
            p12_path.to_str().unwrap(),
            "--password",
            "secret",
        ])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(0));
    let signed_file = dir.path().join("contract-signed.pdf");
    assert!(signed_file.exists());
}

#[test]
fn unsupported_commands_leave_inputs_and_outputs_untouched() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("input.pdf");
    let original = create_pdf("Keep this document unchanged.");
    fs::write(&input, &original).unwrap();

    for command in ["pdfa", "tag", "ocr", "compress"] {
        let destination = dir.path().join(command).join("output.pdf");
        let output = Command::new(binary_path())
            .arg(command).arg(&input).arg("-o").arg(&destination)
            .output().unwrap();
        assert_eq!(output.status.code(), Some(2), "{command}");
        assert!(output.stdout.is_empty(), "{command}");
        assert!(String::from_utf8_lossy(&output.stderr).contains("not supported"));
        assert!(!destination.parent().unwrap().exists(), "{command}");
        assert_eq!(fs::read(&input).unwrap(), original);
    }

    // Refusing an operation must also preserve an existing destination.
    let output = Command::new(binary_path())
        .arg("pdfa").arg(&input).arg("-o").arg(&input)
        .output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(fs::read(&input).unwrap(), original);
}

#[test]
fn office_exports_fail_without_creating_fake_office_files() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("input.pdf");
    fs::write(&input, create_pdf("Document text")).unwrap();
    for format in ["docx", "xlsx"] {
        let destination = dir.path().join(format).join(format!("output.{format}"));
        let output = Command::new(binary_path())
            .arg("export").arg(&input).args(["--to", format, "-o"])
            .arg(&destination).output().unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
        assert!(String::from_utf8_lossy(&output.stderr).contains("not supported"));
        assert!(!destination.parent().unwrap().exists());
    }
}

#[test]
fn text_and_html_exports_contain_extracted_text_in_the_correct_format() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("input.pdf");
    let text = "<script>alert('x')</script> & \"quoted\"";
    fs::write(&input, create_pdf(text)).unwrap();

    for format in ["txt", "html"] {
        let destination = dir.path().join(format!("output.{format}"));
        let output = Command::new(binary_path())
            .arg("export").arg(&input).args(["--to", format, "-o"])
            .arg(&destination).output().unwrap();
        assert_eq!(output.status.code(), Some(0), "{}", String::from_utf8_lossy(&output.stderr));
        let exported = fs::read_to_string(&destination).unwrap();
        if format == "txt" {
            assert!(exported.contains(text), "{exported:?}");
        } else {
            assert!(exported.starts_with("<!doctype html>"));
            assert!(exported.contains("<meta charset=\"utf-8\">"));
            assert!(exported.contains("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; &quot;quoted&quot;"), "{exported:?}");
            assert!(!exported.contains("<script>"));
            assert!(exported.contains("</pre></body></html>"));
        }
    }
}

#[test]
fn export_write_failures_return_nonzero_without_claiming_success() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("input.pdf");
    fs::write(&input, create_pdf("Document text")).unwrap();
    // A file used as a parent fails reliably even under root and on Windows.
    let blocked = dir.path().join("blocked");
    fs::write(&blocked, b"preserve me").unwrap();
    for format in ["txt", "html"] {
        let destination = blocked.join(format!("output.{format}"));
        let output = Command::new(binary_path())
            .arg("export").arg(&input).args(["--to", format, "-o"])
            .arg(&destination).output().unwrap();
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());
        assert!(!output.stderr.is_empty());
        assert!(!destination.exists());
        assert_eq!(fs::read(&blocked).unwrap(), b"preserve me");
    }
}

#[test]
fn workflows_reject_unsupported_steps_before_writing_any_output() {
    use serde_json::json;
    let dir = tempdir().unwrap();
    let input = dir.path().join("input.pdf");
    let original = create_pdf("Original document");
    fs::write(&input, &original).unwrap();
    let workflow_path = dir.path().join("workflow.json");
    let destination = dir.path().join("output").join("result.pdf");
    for step in [
        json!({"action": "pdfa", "part": 2}),
        json!({"action": "ocr"}),
        json!({"action": "rotate", "pages": "all", "delta": 90}),
        json!({"action": "deletePages", "pages": "1"}),
        json!({"action": "stamp", "pages": "all", "stamp": {
            "template": "Reviewed", "position": "bc", "size": 10
        }}),
        json!({"action": "plugin", "plugin": "example", "command": "run"}),
        json!({"action": "future-operation"}),
        json!({"action": "markPatterns", "patterns": ["email"]}),
        json!({"action": "markTerms", "terms": ["Original"]}),
        json!({"action": "applyRedactions"}),
    ] {
        let workflow = json!({
            "format": "openquire-workflow", "version": 1, "name": "Review",
            "steps": [{"action": "setMeta", "meta": {"title": "Changed"}}, step.clone()]
        });
        fs::write(&workflow_path, workflow.to_string()).unwrap();
        let output = Command::new(binary_path())
            .arg("run").arg(&workflow_path).arg(&input).arg("-o").arg(&destination)
            .output().unwrap();
        assert_eq!(output.status.code(), Some(2), "{workflow}");
        assert!(output.stdout.is_empty());
        let error = String::from_utf8_lossy(&output.stderr);
        assert!(error.contains("Workflow step 2 is not supported"), "{error}");
        assert!(!destination.parent().unwrap().exists());
        assert_eq!(fs::read(&input).unwrap(), original);
    }
}

#[test]
fn supported_workflow_still_updates_metadata() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("input.pdf");
    fs::write(&input, create_pdf("Document text")).unwrap();
    let workflow = dir.path().join("workflow.json");
    fs::write(&workflow, r#"{
        "format":"openquire-workflow","version":1,"name":"Review",
        "steps":[{"action":"setMeta","meta":{"title":"Reviewed"}}]
    }"#).unwrap();
    let destination = dir.path().join("result.pdf");
    let output = Command::new(binary_path())
        .arg("run").arg(&workflow).arg(&input).arg("-o").arg(&destination)
        .output().unwrap();
    assert_eq!(output.status.code(), Some(0), "{}", String::from_utf8_lossy(&output.stderr));
    let bytes = fs::read(&destination).unwrap();
    let document = PdfDocument::open("result.pdf".to_string(), &bytes).unwrap();
    assert_eq!(document.get_metadata().title.as_deref(), Some("Reviewed"));
    assert!(document.extract_text().contains("Document text"));
}

#[test]
fn unsupported_signature_timestamp_does_not_write_output() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("input.pdf");
    fs::write(&input, create_pdf("Document text")).unwrap();
    let destination = dir.path().join("signed.pdf");
    let output = Command::new(binary_path())
        .arg("sign").arg(&input).args(["--timestamp", "https://example.invalid/tsa", "-o"])
        .arg(&destination).output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("Timestamped signing"));
    assert!(output.stdout.is_empty());
    assert!(!destination.exists());
}

#[test]
fn info_reports_unimplemented_checks_as_unknown() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("input.pdf");
    fs::write(&input, create_pdf("Document text")).unwrap();
    let output = Command::new(binary_path()).arg("info").arg(&input).output().unwrap();
    assert_eq!(output.status.code(), Some(0));
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(text.contains("pages: 1"));
    for field in ["signatures", "tagged", "PDF/A", "form fields", "comments"] {
        assert!(text.contains(&format!("{field}: unknown")), "{text}");
    }
}

#[test]
fn future_workflow_versions_fail_before_creating_output() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("input.pdf");
    fs::write(&input, create_pdf("Document text")).unwrap();
    let workflow = dir.path().join("workflow.json");
    fs::write(&workflow, r#"{
        "format":"openquire-workflow","version":2,"name":"Future",
        "steps":[{"action":"setMeta","meta":{"title":"Changed"}}]
    }"#).unwrap();
    let destination = dir.path().join("output").join("result.pdf");
    let output = Command::new(binary_path())
        .arg("run").arg(&workflow).arg(&input).arg("-o").arg(&destination)
        .output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("Unsupported workflow version: 2"));
    assert!(output.stdout.is_empty());
    assert!(!destination.parent().unwrap().exists());
}

#[test]
fn mixed_redaction_workflows_fail_before_writing() {
    use serde_json::json;
    let dir = tempdir().unwrap();
    let input = dir.path().join("input.pdf");
    let original = create_pdf("Secret contact: test@example.com");
    fs::write(&input, &original).unwrap();
    let workflow_path = dir.path().join("workflow.json");
    let destination = dir.path().join("output").join("result.pdf");
    for steps in [
        json!([{"action": "markTerms", "terms": ["Secret"]}]),
        json!([{"action": "markPatterns", "patterns": ["email"]}]),
        json!([
            {"action": "markTerms", "terms": ["Secret"]},
            {"action": "applyRedactions"},
            {"action": "setMeta", "meta": {"title": "Changed"}},
            {"action": "markPatterns", "patterns": ["email"]}
        ]),
    ] {
        let workflow = json!({
            "format": "openquire-workflow", "version": 1, "name": "Redact", "steps": steps
        });
        fs::write(&workflow_path, workflow.to_string()).unwrap();
        let output = Command::new(binary_path())
            .arg("run").arg(&workflow_path).arg(&input).arg("-o").arg(&destination)
            .output().unwrap();
        assert_eq!(output.status.code(), Some(2), "{workflow}");
        assert!(String::from_utf8_lossy(&output.stderr).contains("Workflow step 1 is not supported"));
        assert!(output.stdout.is_empty());
        assert!(!destination.parent().unwrap().exists());
        assert_eq!(fs::read(&input).unwrap(), original);
    }
}

