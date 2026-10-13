//! Smart cards and hardware tokens through PKCS#11: list the certificates on a token, and sign
//! with its private key. The key never leaves the device.

use cryptoki::context::{CInitializeArgs, CInitializeFlags, Pkcs11};
use cryptoki::mechanism::Mechanism;
use cryptoki::object::{Attribute, AttributeType, ObjectClass};
use cryptoki::session::UserType;
use cryptoki::slot::Slot;
use cryptoki::types::AuthPin;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenCert {
    /// The slot the token is in.
    pub slot: u64,
    /// The token's label, e.g. the card holder's name.
    pub token: String,
    /// CKA_ID, in hex: matches the certificate to its private key.
    pub id: String,
    pub label: String,
    /// The certificate, DER encoded.
    pub der: Vec<u8>,
    /// Whether the PIN is entered on the reader's own keypad.
    pub pinpad: bool,
}

fn open(module: &str) -> Result<Pkcs11, String> {
    let p = Pkcs11::new(module).map_err(|e| format!("Couldn't load the smart card library {module}: {e}"))?;
    p.initialize(CInitializeArgs::new(CInitializeFlags::OS_LOCKING_OK))
        .map_err(|e| format!("Couldn't start the smart card library: {e}"))?;
    Ok(p)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Result<Vec<u8>, String> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2).unwrap_or(""), 16).map_err(|e| e.to_string()))
        .collect()
}

fn slot_by_id(p: &Pkcs11, id: u64) -> Result<Slot, String> {
    p.get_slots_with_token()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|s| s.id() == id)
        .ok_or_else(|| "The smart card was removed.".to_string())
}

/// Every certificate on every token the library can see.
pub fn list_token_certificates(module: &str) -> Result<Vec<TokenCert>, String> {
    let p = open(module)?;
    let mut out = Vec::new();
    for slot in p.get_slots_with_token().map_err(|e| e.to_string())? {
        let Ok(info) = p.get_token_info(slot) else { continue };
        if !info.token_initialized() {
            continue;
        }
        let token = info.label().trim().to_string();
        let pinpad = info.protected_authentication_path();
        let Ok(session) = p.open_ro_session(slot) else { continue };
        let certs = session
            .find_objects(&[Attribute::Class(ObjectClass::CERTIFICATE)])
            .map_err(|e| e.to_string())?;
        for handle in certs {
            let attrs = session
                .get_attributes(handle, &[AttributeType::Value, AttributeType::Id, AttributeType::Label])
                .map_err(|e| e.to_string())?;
            let (mut der, mut id, mut label) = (Vec::new(), Vec::new(), String::new());
            for a in attrs {
                match a {
                    Attribute::Value(v) => der = v,
                    Attribute::Id(v) => id = v,
                    Attribute::Label(v) => label = String::from_utf8_lossy(&v).into_owned(),
                    _ => {}
                }
            }
            if !der.is_empty() {
                out.push(TokenCert { slot: slot.id(), token: token.clone(), id: hex(&id), label, der, pinpad });
            }
        }
    }
    Ok(out)
}

/// Signs a DER DigestInfo with the private key whose CKA_ID is `id` (RSA PKCS#1 v1.5).
pub fn sign_with_token(module: &str, slot: u64, id: &str, pin: &str, digest_info: &[u8]) -> Result<Vec<u8>, String> {
    let p = open(module)?;
    let slot = slot_by_id(&p, slot)?;
    let session = p.open_ro_session(slot).map_err(|e| e.to_string())?;
    let pin = if pin.is_empty() { None } else { Some(AuthPin::new(pin.into())) };
    session.login(UserType::User, pin.as_ref()).map_err(|e| {
        let text = e.to_string();
        if text.contains("PinIncorrect") || text.contains("PIN_INCORRECT") {
            "Wrong PIN.".to_string()
        } else if text.contains("PinLocked") || text.contains("PIN_LOCKED") {
            "The PIN is locked. Unlock it in your smart card software.".to_string()
        } else {
            text
        }
    })?;
    let key_id = unhex(id)?;
    let keys = session
        .find_objects(&[
            Attribute::Class(ObjectClass::PRIVATE_KEY),
            Attribute::Id(key_id),
            Attribute::Sign(true),
        ])
        .map_err(|e| e.to_string())?;
    let key = keys.into_iter().next().ok_or("The private key for this certificate was not found on the card.")?;
    let signature = session.sign(&Mechanism::RsaPkcs, key, digest_info).map_err(|e| e.to_string());
    let _ = session.logout();
    signature
}
