//! The API keys live in the operating system's credential store, one per
//! provider, and are never written to disk by Open GIT itself.

use keyring::Entry;

use crate::{Error, Provider, Result};

const SERVICE: &str = "open-git";

fn entry(provider: Provider) -> Result<Entry> {
    let host = provider.host().ok_or(Error::Keyless(provider.label()))?;
    Ok(Entry::new(SERVICE, host)?)
}

/// The stored key, or `None` when the user never gave one (or removed it).
pub fn load_key(provider: Provider) -> Result<Option<String>> {
    match entry(provider)?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub fn save_key(provider: Provider, key: &str) -> Result<()> {
    entry(provider)?.set_password(key)?;
    Ok(())
}

pub fn clear_key(provider: Provider) -> Result<()> {
    match entry(provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.into()),
    }
}
