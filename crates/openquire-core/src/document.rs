//! PDF Document abstractions and operations.

use crate::redact::redact_document;
use crate::stamp::{apply_stamp_to_page, format_stamp_text};
use crate::types::{DocumentInfo, Metadata, StampSpec};
use anyhow::{anyhow, Result};
use chrono::Utc;
use lopdf::{Document, Object, ObjectId, StringFormat};
use openquire_crypto::{create_pades_cms_signature, read_digital_id, SignOptions};
use regex::Regex;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub struct PdfDocument {
    pub name: String,
    pub doc: Document,
}

impl PdfDocument {
    pub fn open(name: String, bytes: &[u8]) -> Result<Self> {
        let doc = Document::load_mem(bytes)
            .map_err(|e| anyhow!("Failed to load PDF document '{}': {:?}", name, e))?;
        Ok(Self { name, doc })
    }

    pub fn page_count(&self) -> usize {
        self.doc.get_pages().len()
    }

    pub fn is_encrypted(&self) -> bool {
        self.doc.is_encrypted()
    }

    pub fn get_metadata(&self) -> Metadata {
        let mut meta = Metadata::default();
        if let Ok(info_id) = self.doc.trailer.get(b"Info").and_then(|o| o.as_reference()) {
            if let Ok(info_dict) = self.doc.get_object(info_id).and_then(|o| o.as_dict()) {
                if let Ok(title) = info_dict.get(b"Title").and_then(|o| o.as_str()) {
                    meta.title = Some(String::from_utf8_lossy(title).into_owned());
                }
                if let Ok(author) = info_dict.get(b"Author").and_then(|o| o.as_str()) {
                    meta.author = Some(String::from_utf8_lossy(author).into_owned());
                }
                if let Ok(subj) = info_dict.get(b"Subject").and_then(|o| o.as_str()) {
                    meta.subject = Some(String::from_utf8_lossy(subj).into_owned());
                }
                if let Ok(kw) = info_dict.get(b"Keywords").and_then(|o| o.as_str()) {
                    meta.keywords = Some(String::from_utf8_lossy(kw).into_owned());
                }
            }
        }
        meta
    }

    pub fn set_metadata(&mut self, meta: &Metadata) {
        let info_id = if let Ok(id) = self.doc.trailer.get(b"Info").and_then(|o| o.as_reference()) {
            id
        } else {
            let id = self.doc.add_object(Object::Dictionary(lopdf::Dictionary::new()));
            self.doc.trailer.set("Info", Object::Reference(id));
            id
        };

        if let Ok(info_dict) = self.doc.get_object_mut(info_id).and_then(|o| o.as_dict_mut()) {
            if let Some(t) = &meta.title {
                info_dict.set("Title", Object::String(t.as_bytes().to_vec(), StringFormat::Literal));
            }
            if let Some(a) = &meta.author {
                info_dict.set("Author", Object::String(a.as_bytes().to_vec(), StringFormat::Literal));
            }
            if let Some(s) = &meta.subject {
                info_dict.set("Subject", Object::String(s.as_bytes().to_vec(), StringFormat::Literal));
            }
            if let Some(k) = &meta.keywords {
                info_dict.set("Keywords", Object::String(k.as_bytes().to_vec(), StringFormat::Literal));
            }
        }
    }

    pub fn extract_text(&self) -> String {
        let pages = self.doc.get_pages();
        let page_numbers: Vec<u32> = pages.keys().cloned().collect();
        let texts = self.doc.extract_text(&page_numbers).unwrap_or_default();
        texts
    }

    pub fn info(&self) -> DocumentInfo {
        let pages = self.page_count();
        let encrypted = self.is_encrypted();
        let metadata = self.get_metadata();

        DocumentInfo {
            file_name: self.name.clone(),
            pages,
            encrypted,
            metadata,
            signatures: Vec::new(),
            tagged: false,
            pdfa_status: None,
            form_fields_count: 0,
            comments_count: 0,
        }
    }

    pub fn redact(&mut self, regexes: &[Regex], terms: &[String]) -> Result<usize> {
        redact_document(&mut self.doc, regexes, terms)
    }

    pub fn stamp(&mut self, spec: &StampSpec, bates_counter: &mut u64) -> Result<()> {
        let pages: BTreeMap<u32, ObjectId> = self.doc.get_pages();
        let total_pages = pages.len();
        let digits = spec.bates_digits.unwrap_or(6);

        for (page_idx, (&_num, &page_id)) in pages.iter().enumerate() {
            let text = format_stamp_text(
                &spec.template,
                page_idx + 1,
                total_pages,
                &self.name,
                *bates_counter,
                digits,
            );
            apply_stamp_to_page(&mut self.doc, page_id, &text, spec.position, spec.size)
                .map_err(|e| anyhow!("Failed to stamp page: {:?}", e))?;
            *bates_counter += 1;
        }

        Ok(())
    }

    pub fn set_pdfa_part(&mut self, part: u32) {
        let xmp = format!(
            "<?xpacket begin=\"\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n\
            <x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n \
            <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n  \
            <rdf:Description rdf:about=\"\" xmlns:pdfaid=\"http://www.aiim.org/pdfa/ns/id/\">\n   \
            <pdfaid:part>{}</pdfaid:part>\n   \
            <pdfaid:conformance>B</pdfaid:conformance>\n  \
            </rdf:Description>\n \
            </rdf:RDF>\n\
            </x:xmpmeta>\n\
            <?xpacket end=\"w\"?>",
            part
        );

        let mut stream_dict = lopdf::Dictionary::new();
        stream_dict.set("Type", "Metadata");
        stream_dict.set("Subtype", "XML");
        let meta_stream_id = self.doc.add_object(Object::Stream(lopdf::Stream::new(stream_dict, xmp.into_bytes())));
        if let Ok(catalog_id) = self.doc.trailer.get(b"Root").and_then(|o| o.as_reference()) {
            if let Ok(catalog_dict) = self.doc.get_object_mut(catalog_id).and_then(|o| o.as_dict_mut()) {
                catalog_dict.set("Metadata", Object::Reference(meta_stream_id));
            }
        }
    }

    pub fn append(&mut self, other_bytes: &[u8]) -> Result<()> {
        let mut other_doc = Document::load_mem(other_bytes)
            .map_err(|e| anyhow!("Failed to load document to append: {:?}", e))?;

        let starting_id = self.doc.max_id + 1;
        other_doc.renumber_objects_with(starting_id);

        let pages_tree_id = self.doc.catalog()
            .and_then(|c| c.get(b"Pages"))
            .and_then(|p| p.as_reference())
            .ok();

        let other_pages = other_doc.get_pages();

        // Copy all renumbered objects from other_doc into self.doc (excluding other's root and pages catalog)
        for (id, obj) in other_doc.objects {
            if let Ok(dict) = obj.as_dict() {
                if let Ok(t) = dict.get(b"Type").and_then(|t| t.as_name()) {
                    if t == b"Catalog" || t == b"Pages" {
                        continue;
                    }
                }
            }
            self.doc.objects.insert(id, obj);
        }

        // Attach each page to self.doc Pages tree
        for (&_page_num, &page_id) in other_pages.iter() {
            if let Some(tree_id) = pages_tree_id {
                if let Ok(page_dict) = self.doc.get_object_mut(page_id).and_then(|o| o.as_dict_mut()) {
                    page_dict.set("Parent", Object::Reference(tree_id));
                }
                if let Ok(pages_dict) = self.doc.get_object_mut(tree_id).and_then(|o| o.as_dict_mut()) {
                    if let Ok(kids) = pages_dict.get_mut(b"Kids").and_then(|o| o.as_array_mut()) {
                        kids.push(Object::Reference(page_id));
                    }
                    if let Ok(count_obj) = pages_dict.get_mut(b"Count") {
                        if let Object::Integer(ref mut c) = count_obj {
                            *c += 1;
                        }
                    }
                }
            }
        }

        self.doc.max_id = self.doc.objects.keys().map(|id| id.0).max().unwrap_or(0);
        Ok(())
    }

    pub fn sign(
        &mut self,
        p12_bytes: &[u8],
        password: &str,
        reason: Option<&str>,
        location: Option<&str>,
    ) -> Result<Vec<u8>> {
        // Build the signed copy without corrupting the open document on failure.
        let mut candidate = Self { name: self.name.clone(), doc: self.doc.clone() };
        candidate.sign_copy(p12_bytes, password, reason, location)
    }

    fn sign_copy(
        &mut self,
        p12_bytes: &[u8],
        password: &str,
        _reason: Option<&str>,
        _location: Option<&str>,
    ) -> Result<Vec<u8>> {
        if self.doc.is_encrypted() {
            return Err(anyhow!("Native signing of encrypted PDFs is not supported"));
        }
        if self.doc.objects.values().any(|o| o.as_dict().map(|d| d.has(b"ByteRange") || d.get(b"FT").and_then(|v| v.as_name()).ok() == Some(b"Sig".as_slice())).unwrap_or(false)) {
            return Err(anyhow!("Native signing cannot preserve existing signatures; use the Node CLI or app"));
        }
        let first_page_id = self.doc.page_iter().next().ok_or_else(|| anyhow!("Cannot sign a PDF without pages"))?;
        let digital_id = read_digital_id(p12_bytes, password)?;
        // Resolve indirect form/annotation containers before adding the signature.
        fn resolved(doc: &Document, value: &Object) -> Result<Object> {
            Ok(match value { Object::Reference(id) => doc.get_object(*id)?.clone(), _ => value.clone() })
        }
        let mut acro_form = match self.doc.catalog()?.get(b"AcroForm") {
            Ok(value) => resolved(&self.doc, value)?.as_dict()?.clone(),
            Err(_) => lopdf::Dictionary::new(),
        };
        let mut fields = match acro_form.get(b"Fields") {
            Ok(value) => resolved(&self.doc, value)?.as_array()?.clone(),
            Err(_) => Vec::new(),
        };
        let mut annots = match self.doc.get_object(first_page_id)?.as_dict()?.get(b"Annots") {
            Ok(value) => resolved(&self.doc, value)?.as_array()?.clone(),
            Err(_) => Vec::new(),
        };

        // 1. Create signature object placeholder
        let placeholder_size = 8192; // 8KB for CMS signature
        let placeholder = vec![0; placeholder_size];

        let mut sig_dict = lopdf::Dictionary::new();
        sig_dict.set("Type", "Sig");
        sig_dict.set("Filter", "Adobe.PPKLite");
        sig_dict.set("SubFilter", "adbe.pkcs7.detached");
        sig_dict.set("ByteRange", Object::Array(vec![0.into(), 1_000_000_000.into(), 1_000_000_000.into(), 1_000_000_000.into()]));
        sig_dict.set("Contents", Object::String(placeholder, StringFormat::Hexadecimal));
        sig_dict.set("Name", Object::String(digital_id.name.clone().into_bytes(), StringFormat::Literal));
        if let Some(r) = _reason {
            sig_dict.set("Reason", Object::String(r.as_bytes().to_vec(), StringFormat::Literal));
        }
        if let Some(l) = _location {
            sig_dict.set("Location", Object::String(l.as_bytes().to_vec(), StringFormat::Literal));
        }
        let now_str = Utc::now().format("D:%Y%m%d%H%M%SZ").to_string();
        sig_dict.set("M", Object::String(now_str.into_bytes(), StringFormat::Literal));
        let sig_obj_id = self.doc.add_object(Object::Dictionary(sig_dict));

        // 2. Create signature form field
        let mut field_dict = lopdf::Dictionary::new();
        field_dict.set("Type", "Annot");
        field_dict.set("Subtype", "Widget");
        field_dict.set("FT", "Sig");
        field_dict.set("T", Object::String(b"Signature1".to_vec(), StringFormat::Literal));
        field_dict.set("F", 132);
        field_dict.set("P", Object::Reference(first_page_id));
        field_dict.set("V", Object::Reference(sig_obj_id));
        field_dict.set("Rect", Object::Array(vec![0.into(), 0.into(), 0.into(), 0.into()]));
        let field_obj_id = self.doc.add_object(Object::Dictionary(field_dict));

        // 3. Preserve existing form fields and page annotations.
        fields.push(Object::Reference(field_obj_id));
        acro_form.set("Fields", Object::Array(fields));
        acro_form.set("SigFlags", 3);
        let catalog_id = self.doc.trailer.get(b"Root")?.as_reference()?;
        self.doc.get_object_mut(catalog_id)?.as_dict_mut()?.set("AcroForm", Object::Dictionary(acro_form));
        annots.push(Object::Reference(field_obj_id));
        self.doc.get_object_mut(first_page_id)?.as_dict_mut()?.set("Annots", Object::Array(annots));

        // 5. Save document and patch ByteRange + Contents
        let mut out = Vec::new();
        self.doc.save_to(&mut out)?;

        let needle = format!("<{}>", "0".repeat(placeholder_size * 2));
        let positions: Vec<_> = out.windows(needle.len()).enumerate()
            .filter_map(|(i, window)| (window == needle.as_bytes()).then_some(i)).collect();
        if positions.len() != 1 { return Err(anyhow!("Signature Contents placeholder missing or ambiguous")); }
        let pos = positions[0];
        {
            let content_start = pos;
            let content_end = pos + needle.len();

            let range_1 = 0;
            let len_1 = content_start;
            let range_2 = content_end;
            let len_2 = out.len() - content_end;

            // Update ByteRange string FIRST before hashing
            let br_placeholder = "[0 1000000000 1000000000 1000000000]";
            let positions: Vec<_> = out.windows(br_placeholder.len()).enumerate()
                .filter_map(|(i, window)| (window == br_placeholder.as_bytes()).then_some(i)).collect();
            if positions.len() != 1 { return Err(anyhow!("Signature ByteRange placeholder missing or ambiguous")); }
            let br_pos = positions[0];
            {
                let br_actual = format!("[{} {} {} {}]", range_1, len_1, range_2, len_2);
                if br_actual.len() > br_placeholder.len() { return Err(anyhow!("Signature ByteRange exceeds reserved space")); }
                let padded = format!("{:width$}", br_actual, width = br_placeholder.len());
                out[br_pos..br_pos + br_placeholder.len()].copy_from_slice(padded.as_bytes());
            }

            // Compute hash of the two byte ranges
            let mut hasher = Sha256::new();
            hasher.update(&out[range_1..range_1 + len_1]);
            hasher.update(&out[range_2..range_2 + len_2]);
            let digest: [u8; 32] = hasher.finalize().into();

            let sign_opts = SignOptions {
                digital_id: &digital_id,
                content_digest: digest,
                signing_time: None,
            };
            let cms_sig = create_pades_cms_signature(&sign_opts)?;
            let hex_sig = hex::encode(cms_sig);

            if hex_sig.len() > placeholder_size * 2 { return Err(anyhow!("CMS signature exceeds reserved space")); }
            // Write hex signature into contents placeholder
            let sig_slice = &mut out[content_start + 1..content_start + 1 + hex_sig.len()];
            sig_slice.copy_from_slice(hex_sig.as_bytes());
        }

        Ok(out)
    }

    pub fn save(&mut self) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        self.doc.save_to(&mut out)?;
        Ok(out)
    }
}

