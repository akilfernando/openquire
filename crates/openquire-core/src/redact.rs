//! Text search and permanent redaction.

use lopdf::content::Content;
use lopdf::{Document, Object, ObjectId};
use regex::Regex;

pub fn redact_document(doc: &mut Document, regexes: &[Regex], terms: &[String]) -> usize {
    let mut total_matches = 0;
    let page_ids = doc.page_iter().collect::<Vec<ObjectId>>();

    for page_id in page_ids {
        if let Ok(count) = redact_page(doc, page_id, regexes, terms) {
            total_matches += count;
        }
    }

    total_matches
}

pub fn redact_page(
    doc: &mut Document,
    page_id: ObjectId,
    regexes: &[Regex],
    terms: &[String],
) -> Result<usize, lopdf::Error> {
    let mut matches = 0;
    let content_data = doc.get_page_content(page_id);
    let mut content = Content::decode(&content_data)?;

    for op in &mut content.operations {
        if op.operator == "Tj" || op.operator == "'" || op.operator == "\"" {
            for operand in &mut op.operands {
                if let Object::String(bytes, _) = operand {
                    let text = String::from_utf8_lossy(bytes).into_owned();
                    let (new_text, count) = apply_text_redactions(&text, regexes, terms);
                    if count > 0 {
                        matches += count;
                        *bytes = new_text.into_bytes();
                    }
                }
            }
        } else if op.operator == "TJ" {
            for operand in &mut op.operands {
                if let Object::Array(arr) = operand {
                    for item in arr {
                        if let Object::String(bytes, _) = item {
                            let text = String::from_utf8_lossy(bytes).into_owned();
                            let (new_text, count) = apply_text_redactions(&text, regexes, terms);
                            if count > 0 {
                                matches += count;
                                *bytes = new_text.into_bytes();
                            }
                        }
                    }
                }
            }
        }
    }

    if matches > 0 {
        let new_content_bytes = content.encode()?;
        let stream_obj_id = doc.add_object(Object::Stream(lopdf::Stream::new(
            lopdf::Dictionary::new(),
            new_content_bytes,
        )));
        // Update page content stream
        if let Ok(page_dict) = doc.get_object_mut(page_id).and_then(|o| o.as_dict_mut()) {
            page_dict.set("Contents", Object::Reference(stream_obj_id));
        }
    }

    Ok(matches)
}

fn apply_text_redactions(text: &str, regexes: &[Regex], terms: &[String]) -> (String, usize) {
    let mut current = text.to_string();
    let mut count = 0;

    for term in terms {
        if !term.is_empty() && current.contains(term) {
            let occurrences = current.matches(term).count();
            count += occurrences;
            current = current.replace(term, "");
        }
    }

    for re in regexes {
        let matches = re.find_iter(&current).count();
        if matches > 0 {
            count += matches;
            current = re.replace_all(&current, "").to_string();
        }
    }

    (current, count)
}
