//! The GitHub token lives in the operating system's credential store and is
//! never written to disk by gitui itself.

use keyring::Entry;

use crate::Result;

const SERVICE: &str = "gitui";
const ACCOUNT: &str = "github.com";

fn entry() -> Result<Entry> {
    Ok(Entry::new(SERVICE, ACCOUNT)?)
}

/// The stored token, or `None` when the user never signed in (or signed out).
pub fn load_token() -> Result<Option<String>> {
    match entry()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub fn save_token(token: &str) -> Result<()> {
    entry()?.set_password(token)?;
    Ok(())
}

pub fn clear_token() -> Result<()> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.into()),
    }
}
