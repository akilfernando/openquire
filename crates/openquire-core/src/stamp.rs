use crate::types::StampPosition;
use chrono::Utc;
use lopdf::content::{Content, Operation};
use lopdf::{Document, Object, ObjectId, StringFormat};

pub fn format_stamp_text(
    template: &str,
    page_num: usize,
    total_pages: usize,
    doc_name: &str,
    bates_num: u64,
    bates_digits: usize,
) -> String {
    let bates_str = format!("{:0width$}", bates_num, width = bates_digits);
    let today = Utc::now().format("%Y-%m-%d").to_string();

    template
        .replace("{page}", &page_num.to_string())
        .replace("{pages}", &total_pages.to_string())
        .replace("{date}", &today)
        .replace("{name}", doc_name)
        .replace("{bates}", &bates_str)
}

/// Applies a stamp to a specific page in a lopdf Document.
pub fn apply_stamp_to_page(
    doc: &mut Document,
    page_id: ObjectId,
    text: &str,
    position: StampPosition,
    font_size: f32,
) -> Result<(), lopdf::Error> {
    // 1. Ensure a standard font (Helvetica) is registered in page Resources /Font
    let font_name = b"F_STAMP".to_vec();
    
    // Add Helvetica font to document if not present
    let mut font_dict = lopdf::Dictionary::new();
    font_dict.set("Type", "Font");
    font_dict.set("Subtype", "Type1");
    font_dict.set("BaseFont", "Helvetica");
    let font_obj_id = doc.add_object(Object::Dictionary(font_dict));

    // Update page resources
    if let Ok(page_dict) = doc.get_object_mut(page_id).and_then(|o| o.as_dict_mut()) {
        let mut resources = if let Ok(res) = page_dict.get_mut(b"Resources").and_then(|r| r.as_dict_mut()) {
            res.clone()
        } else {
            lopdf::Dictionary::new()
        };

        let mut fonts = if let Ok(f) = resources.get_mut(b"Font").and_then(|f| f.as_dict_mut()) {
            f.clone()
        } else {
            lopdf::Dictionary::new()
        };

        fonts.set(font_name.clone(), Object::Reference(font_obj_id));
        resources.set("Font", Object::Dictionary(fonts));
        page_dict.set("Resources", Object::Dictionary(resources));
    }

    // 2. Position coordinates: standard letter is 612 x 792, A4 is 595 x 842.
    // Default fallback page bounds: [0, 0, 595, 842]
    let (width, height) = (595.0, 842.0);
    let margin = 36.0;

    let (x, y) = match position {
        StampPosition::Tl => (margin, height - margin),
        StampPosition::Tc => (width / 2.0 - (text.len() as f32 * font_size * 0.25), height - margin),
        StampPosition::Tr => (width - margin - (text.len() as f32 * font_size * 0.5), height - margin),
        StampPosition::Bl => (margin, margin),
        StampPosition::Bc => (width / 2.0 - (text.len() as f32 * font_size * 0.25), margin),
        StampPosition::Br => (width - margin - (text.len() as f32 * font_size * 0.5), margin),
        StampPosition::Center => (width / 2.0 - (text.len() as f32 * font_size * 0.25), height / 2.0),
    };

    // 3. Construct PDF content stream operations: BT /F_STAMP font_size Tf x y Td (text) Tj ET
    let ops = vec![
        Operation::new("q", vec![]),
        Operation::new("BT", vec![]),
        Operation::new("Tf", vec![Object::Name(font_name), Object::Real(font_size)]),
        Operation::new("Td", vec![Object::Real(x), Object::Real(y)]),
        Operation::new("Tj", vec![Object::String(text.as_bytes().to_vec(), StringFormat::Literal)]),
        Operation::new("ET", vec![]),
        Operation::new("Q", vec![]),
    ];

    let content = Content { operations: ops };
    let content_bytes = content.encode()?;
    let stream_obj_id = doc.add_object(Object::Stream(lopdf::Stream::new(lopdf::Dictionary::new(), content_bytes)));

    // Append stream to page Contents
    if let Ok(page_dict) = doc.get_object_mut(page_id).and_then(|o| o.as_dict_mut()) {
        match page_dict.get_mut(b"Contents") {
            Ok(Object::Array(arr)) => {
                arr.push(Object::Reference(stream_obj_id));
            }
            Ok(Object::Reference(existing_id)) => {
                let existing = *existing_id;
                page_dict.set("Contents", Object::Array(vec![Object::Reference(existing), Object::Reference(stream_obj_id)]));
            }
            _ => {
                page_dict.set("Contents", Object::Reference(stream_obj_id));
            }
        }
    }

    Ok(())
}
