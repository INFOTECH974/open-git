//! The connected GitHub accounts.
//!
//! Each account has its own entry in the operating system's credential store,
//! holding its token and what the UI shows of it; one more entry lists the
//! accounts and names the active one. Open GIT writes none of this to disk itself.

use keyring::Entry;
use serde::{Deserialize, Serialize};

use crate::{Account, Credential, Error, Result};

const SERVICE: &str = "open-git";
/// The entry that lists the connected accounts and names the active one.
const INDEX: &str = "github.com/accounts";
/// Where the versions that knew a single account keep its token. It is left
/// there, so that such a version installed next to this one stays signed in.
const LEGACY: &str = "github.com";

fn entry_name(login: &str) -> String {
    format!("{login}@github.com")
}

/// The connected accounts, in the order they were added.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct Accounts {
    pub accounts: Vec<Account>,
    /// Login of the account that works where nothing names another: one of
    /// `accounts`, as long as there is any.
    pub active: Option<String>,
    /// Logins of the accounts whose token GitHub no longer accepts: revoked,
    /// expired, or the authorisation of the application withdrawn. Never stored:
    /// the application fills it in as GitHub answers.
    pub refused: Vec<String>,
}

/// What an account may do with a repository, as GitHub answered it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Access {
    /// GitHub no longer accepts the token of the account.
    Refused,
    /// GitHub does not show the account the repository: private, and not
    /// shared with it.
    Hidden,
    Read,
    Write,
}

impl Accounts {
    /// The connected account named `login`. GitHub logins ignore case.
    pub fn find(&self, login: &str) -> Option<&Account> {
        self.accounts
            .iter()
            .find(|account| account.login.eq_ignore_ascii_case(login))
    }

    pub fn active(&self) -> Option<&Account> {
        self.find(self.active.as_deref()?)
    }

    /// The account that works on a repository of `owner`: the one the repository
    /// names (`bound`), when it is connected. Otherwise, among the accounts that
    /// `access` knows to reach the repository, one that may push rather than only
    /// read, and between equals the active one, then the owner, then the others
    /// in order. When none is known to reach it (nothing was asked yet, say), its
    /// owner when that is a connected account, else the active one.
    pub fn for_repository(
        &self,
        bound: Option<&str>,
        owner: &str,
        access: impl Fn(&Account) -> Option<Access>,
    ) -> Option<&Account> {
        if let Some(account) = bound.and_then(|login| self.find(login)) {
            return Some(account);
        }
        let active = self.active();
        let owner = self.find(owner);
        let mut best: Option<(Access, &Account)> = None;
        for account in active.into_iter().chain(owner).chain(&self.accounts) {
            if let Some(found) = access(account).filter(|found| *found >= Access::Read)
                && best.is_none_or(|(known, _)| found > known)
            {
                best = Some((found, account));
            }
        }
        best.map(|(_, account)| account).or(owner).or(active)
    }

    /// Whether GitHub no longer accepts the token of the account `login`.
    pub fn is_refused(&self, login: &str) -> bool {
        self.refused
            .iter()
            .any(|refused| refused.eq_ignore_ascii_case(login))
    }

    /// Adds `account`, or replaces the one of the same login, and makes it active.
    fn add(&mut self, account: Account) {
        self.active = Some(account.login.clone());
        let known = self
            .accounts
            .iter_mut()
            .find(|known| known.login.eq_ignore_ascii_case(&account.login));
        match known {
            Some(known) => *known = account,
            None => self.accounts.push(account),
        }
    }

    /// Removes the account named `login`; the first of the others takes over when
    /// it was the active one.
    fn remove(&mut self, login: &str) -> Option<Account> {
        let position = self
            .accounts
            .iter()
            .position(|account| account.login.eq_ignore_ascii_case(login))?;
        let removed = self.accounts.remove(position);
        if self.active().is_none() {
            self.active = self.accounts.first().map(|account| account.login.clone());
        }
        Some(removed)
    }

    fn activate(&mut self, login: &str) -> bool {
        let Some(account) = self.find(login) else {
            return false;
        };
        self.active = Some(account.login.clone());
        true
    }
}

/// Where the secrets are kept: the keychain, or a map in the tests.
trait Vault {
    fn get(&self, name: &str) -> Result<Option<String>>;
    fn set(&self, name: &str, secret: &str) -> Result<()>;
    fn delete(&self, name: &str) -> Result<()>;
}

struct Keychain;

impl Vault for Keychain {
    fn get(&self, name: &str) -> Result<Option<String>> {
        match Entry::new(SERVICE, name)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    fn set(&self, name: &str, secret: &str) -> Result<()> {
        Entry::new(SERVICE, name)?.set_password(secret)?;
        Ok(())
    }

    fn delete(&self, name: &str) -> Result<()> {
        match Entry::new(SERVICE, name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
}

/// What [`INDEX`] holds.
#[derive(Default, Serialize, Deserialize)]
struct Index {
    active: Option<String>,
    logins: Vec<String>,
}

impl Index {
    fn of(accounts: &Accounts) -> Self {
        Self {
            active: accounts.active.clone(),
            logins: accounts
                .accounts
                .iter()
                .map(|account| account.login.clone())
                .collect(),
        }
    }
}

/// What the entry of one account holds.
#[derive(Serialize, Deserialize)]
struct Stored {
    token: String,
    #[serde(flatten)]
    account: Account,
}

struct Store<'a, V>(&'a V);

impl<V: Vault> Store<'_, V> {
    fn write(&self, name: &str, value: &impl Serialize) -> Result<()> {
        let json = serde_json::to_string(value)
            .map_err(|error| keyring::Error::BadStoreFormat(error.to_string()))?;
        self.0.set(name, &json)
    }

    fn stored(&self, login: &str) -> Result<Option<Stored>> {
        let json = self.0.get(&entry_name(login))?;
        Ok(json.and_then(|json| serde_json::from_str(&json).ok()))
    }

    /// The stored accounts in the order they were added, and the login of the
    /// active one. `None` until an account is connected by a version that knows
    /// several: all there may be then is [`LEGACY`].
    fn read(&self) -> Result<Option<(Vec<Stored>, Option<String>)>> {
        let Some(json) = self.0.get(INDEX)? else {
            return Ok(None);
        };
        // A list that cannot be read back lists nothing: signing in rewrites it.
        let index: Index = serde_json::from_str(&json).unwrap_or_default();
        let mut stored = Vec::new();
        for login in &index.logins {
            // An entry may be gone, removed by hand in the keychain.
            if let Some(account) = self.stored(login)? {
                stored.push(account);
            }
        }
        let listed = |login: &String| {
            stored
                .iter()
                .any(|stored| stored.account.login.eq_ignore_ascii_case(login))
        };
        let active = index
            .active
            .filter(listed)
            .or_else(|| stored.first().map(|stored| stored.account.login.clone()));
        Ok(Some((stored, active)))
    }

    fn load(&self) -> Result<Option<Accounts>> {
        Ok(self.read()?.map(|(stored, active)| Accounts {
            accounts: stored.into_iter().map(|stored| stored.account).collect(),
            active,
            refused: Vec::new(),
        }))
    }

    fn save(&self, account: &Account, token: &str) -> Result<Accounts> {
        let mut accounts = self.load()?.unwrap_or_default();
        if let Some(known) = accounts.find(&account.login)
            && known.login != account.login
        {
            // The login changed its capitals on GitHub: the entry has the old ones.
            self.0.delete(&entry_name(&known.login))?;
        }
        let stored = Stored {
            token: token.to_owned(),
            account: account.clone(),
        };
        self.write(&entry_name(&account.login), &stored)?;
        accounts.add(account.clone());
        self.write(INDEX, &Index::of(&accounts))?;
        Ok(accounts)
    }

    fn remove(&self, login: &str) -> Result<Accounts> {
        let mut accounts = self.load()?.unwrap_or_default();
        let Some(removed) = accounts.remove(login) else {
            return Ok(accounts);
        };
        let token = self.token(&removed.login)?;
        self.write(INDEX, &Index::of(&accounts))?;
        self.0.delete(&entry_name(&removed.login))?;
        // Signing out leaves no copy of the token behind.
        if token.is_some() && self.0.get(LEGACY)? == token {
            self.0.delete(LEGACY)?;
        }
        Ok(accounts)
    }

    fn activate(&self, login: &str) -> Result<Accounts> {
        let mut accounts = self.load()?.unwrap_or_default();
        if !accounts.activate(login) {
            return Err(Error::UnknownAccount {
                login: login.to_owned(),
            });
        }
        self.write(INDEX, &Index::of(&accounts))?;
        Ok(accounts)
    }

    fn token(&self, login: &str) -> Result<Option<String>> {
        Ok(self.stored(login)?.map(|stored| stored.token))
    }

    fn credentials(&self) -> Result<Vec<Credential>> {
        let Some((mut stored, active)) = self.read()? else {
            let legacy = self.0.get(LEGACY)?;
            return Ok(legacy
                .map(|token| Credential { login: None, token })
                .into_iter()
                .collect());
        };
        stored.sort_by_key(|stored| Some(&stored.account.login) != active.as_ref());
        Ok(stored
            .into_iter()
            .map(|stored| Credential {
                login: Some(stored.account.login),
                token: stored.token,
            })
            .collect())
    }
}

/// The connected accounts. `None` when no account was ever connected by a version
/// that knows several: [`legacy_token`] may then hold the one of an older version.
pub fn load_accounts() -> Result<Option<Accounts>> {
    Store(&Keychain).load()
}

/// Stores `account` and its token, replacing the account of the same login, and
/// makes it the active one.
pub fn save_account(account: &Account, token: &str) -> Result<Accounts> {
    Store(&Keychain).save(account, token)
}

/// Forgets the account named `login` and its token.
pub fn remove_account(login: &str) -> Result<Accounts> {
    Store(&Keychain).remove(login)
}

/// Makes the account named `login` the active one.
pub fn activate_account(login: &str) -> Result<Accounts> {
    Store(&Keychain).activate(login)
}

/// The token of the account named `login`, or `None` when it is not connected.
pub fn account_token(login: &str) -> Result<Option<String>> {
    Store(&Keychain).token(login)
}

/// The token a version that knew a single account stored, if it did.
pub fn legacy_token() -> Result<Option<String>> {
    Keychain.get(LEGACY)
}

/// What `git` can be answered with: every connected account and its token, the
/// active one first.
pub fn credentials() -> Result<Vec<Credential>> {
    Store(&Keychain).credentials()
}

#[cfg(test)]
mod tests {
    use std::{cell::RefCell, collections::HashMap};

    use super::*;

    #[derive(Default)]
    struct Memory(RefCell<HashMap<String, String>>);

    impl Memory {
        fn has(&self, name: &str) -> bool {
            self.0.borrow().contains_key(name)
        }
    }

    impl Vault for Memory {
        fn get(&self, name: &str) -> Result<Option<String>> {
            Ok(self.0.borrow().get(name).cloned())
        }

        fn set(&self, name: &str, secret: &str) -> Result<()> {
            self.0
                .borrow_mut()
                .insert(name.to_owned(), secret.to_owned());
            Ok(())
        }

        fn delete(&self, name: &str) -> Result<()> {
            self.0.borrow_mut().remove(name);
            Ok(())
        }
    }

    fn account(login: &str) -> Account {
        Account {
            login: login.to_owned(),
            avatar_url: format!("https://avatars.example/{login}"),
            html_url: format!("https://github.com/{login}"),
        }
    }

    fn logins(accounts: &Accounts) -> Vec<&str> {
        accounts
            .accounts
            .iter()
            .map(|account| account.login.as_str())
            .collect()
    }

    fn credential(login: &str, token: &str) -> Credential {
        Credential {
            login: Some(login.to_owned()),
            token: token.to_owned(),
        }
    }

    #[test]
    fn accounts_are_added_switched_and_removed() {
        let memory = Memory::default();
        let store = Store(&memory);
        assert_eq!(store.load().unwrap(), None);
        assert_eq!(store.credentials().unwrap(), []);

        let accounts = store.save(&account("ada"), "token-ada").unwrap();
        assert_eq!(logins(&accounts), ["ada"]);
        assert_eq!(accounts.active.as_deref(), Some("ada"));

        // The account just connected is the one the user wants to work with.
        let accounts = store.save(&account("grace"), "token-grace").unwrap();
        assert_eq!(logins(&accounts), ["ada", "grace"]);
        assert_eq!(accounts.active.as_deref(), Some("grace"));
        assert_eq!(store.load().unwrap(), Some(accounts));

        let accounts = store.activate("ADA").unwrap();
        assert_eq!(accounts.active.as_deref(), Some("ada"));
        assert_eq!(
            store.load().unwrap().unwrap().active.as_deref(),
            Some("ada")
        );
        assert!(matches!(
            store.activate("linus"),
            Err(Error::UnknownAccount { .. })
        ));

        assert_eq!(
            store.token("grace").unwrap().as_deref(),
            Some("token-grace")
        );
        assert_eq!(store.token("linus").unwrap(), None);

        // The other account takes over from the active one that leaves.
        let accounts = store.remove("ada").unwrap();
        assert_eq!(logins(&accounts), ["grace"]);
        assert_eq!(accounts.active.as_deref(), Some("grace"));
        assert!(!memory.has("ada@github.com"));
        assert_eq!(store.token("ada").unwrap(), None);

        let accounts = store.remove("grace").unwrap();
        assert_eq!(accounts, Accounts::default());
        // Signed out of everything is not the same as never signed in.
        assert_eq!(store.load().unwrap(), Some(Accounts::default()));
        assert_eq!(store.credentials().unwrap(), []);
    }

    #[test]
    fn signing_in_again_replaces_the_token_and_the_spelling() {
        let memory = Memory::default();
        let store = Store(&memory);
        store.save(&account("Ada"), "old").unwrap();
        store.save(&account("grace"), "token-grace").unwrap();

        let accounts = store.save(&account("ada"), "new").unwrap();
        assert_eq!(logins(&accounts), ["ada", "grace"]);
        assert_eq!(accounts.active.as_deref(), Some("ada"));
        assert_eq!(store.token("ada").unwrap().as_deref(), Some("new"));
        assert!(!memory.has("Ada@github.com"));
    }

    #[test]
    fn credentials_put_the_active_account_first() {
        let memory = Memory::default();
        let store = Store(&memory);
        store.save(&account("ada"), "token-ada").unwrap();
        store.save(&account("grace"), "token-grace").unwrap();
        store.save(&account("linus"), "token-linus").unwrap();
        store.activate("grace").unwrap();

        assert_eq!(
            store.credentials().unwrap(),
            [
                credential("grace", "token-grace"),
                credential("ada", "token-ada"),
                credential("linus", "token-linus"),
            ]
        );
    }

    #[test]
    fn the_token_of_a_single_account_version_serves_until_accounts_exist() {
        let memory = Memory::default();
        memory.set(LEGACY, "token-ada").unwrap();
        let store = Store(&memory);
        assert_eq!(store.load().unwrap(), None);
        assert_eq!(
            store.credentials().unwrap(),
            [Credential {
                login: None,
                token: "token-ada".to_owned()
            }]
        );

        // Once it became an account, the older version keeps its own entry.
        store.save(&account("ada"), "token-ada").unwrap();
        assert_eq!(
            store.credentials().unwrap(),
            [credential("ada", "token-ada")]
        );
        assert!(memory.has(LEGACY));

        // Another account signing out does not touch it; its own does.
        store.save(&account("grace"), "token-grace").unwrap();
        store.remove("grace").unwrap();
        assert!(memory.has(LEGACY));
        store.remove("ada").unwrap();
        assert!(!memory.has(LEGACY));
        assert_eq!(store.credentials().unwrap(), []);
    }

    #[test]
    fn an_entry_that_is_gone_or_unreadable_is_left_out() {
        let memory = Memory::default();
        let store = Store(&memory);
        store.save(&account("ada"), "token-ada").unwrap();
        store.save(&account("grace"), "token-grace").unwrap();
        store.save(&account("linus"), "token-linus").unwrap();

        memory.delete("grace@github.com").unwrap();
        memory.set("linus@github.com", "not json").unwrap();
        let accounts = store.load().unwrap().unwrap();
        assert_eq!(logins(&accounts), ["ada"]);
        assert_eq!(accounts.active.as_deref(), Some("ada"));

        memory.set(INDEX, "not json").unwrap();
        assert_eq!(store.load().unwrap(), Some(Accounts::default()));
    }

    #[test]
    fn a_repository_uses_its_account_then_its_owner_then_the_active_one() {
        let accounts = Accounts {
            accounts: vec![account("ada"), account("grace"), account("linus")],
            active: Some("linus".to_owned()),
            ..Accounts::default()
        };
        // Nothing is known yet of what each account can reach.
        let chosen = |bound: Option<&str>, owner: &str| {
            accounts
                .for_repository(bound, owner, |_| None)
                .map(|account| account.login.as_str())
        };
        assert_eq!(chosen(Some("Ada"), "grace"), Some("ada"));
        assert_eq!(chosen(None, "Grace"), Some("grace"));
        assert_eq!(chosen(None, "analytical-society"), Some("linus"));
        // An account that signed out since no longer decides.
        assert_eq!(chosen(Some("margaret"), "grace"), Some("grace"));
        assert_eq!(
            chosen(Some("margaret"), "analytical-society"),
            Some("linus")
        );

        assert_eq!(
            Accounts::default().for_repository(Some("ada"), "ada", |_| None),
            None
        );
    }

    #[test]
    fn a_repository_uses_an_account_that_reaches_it_the_active_one_first() {
        let mut accounts = Accounts {
            accounts: vec![account("ada"), account("grace"), account("linus")],
            active: Some("linus".to_owned()),
            ..Accounts::default()
        };
        let chosen = |accounts: &Accounts, bound: Option<&str>, reach: &[(&str, Access)]| {
            accounts
                .for_repository(bound, "grace", |account| {
                    reach
                        .iter()
                        .find(|(login, _)| *login == account.login)
                        .map(|(_, access)| *access)
                })
                .map(|account| account.login.clone())
        };
        let all = |access| [("ada", access), ("grace", access), ("linus", access)];

        // Between equals, the active account, then the owner, then the others.
        assert_eq!(
            chosen(&accounts, None, &all(Access::Write)).as_deref(),
            Some("linus")
        );
        accounts.active = Some("ada".to_owned());
        assert_eq!(
            chosen(&accounts, None, &all(Access::Write)).as_deref(),
            Some("ada")
        );
        assert_eq!(
            chosen(&accounts, None, &all(Access::Read)).as_deref(),
            Some("ada")
        );
        let only_owner_and_linus = [
            ("ada", Access::Hidden),
            ("grace", Access::Write),
            ("linus", Access::Write),
        ];
        assert_eq!(
            chosen(&accounts, None, &only_owner_and_linus).as_deref(),
            Some("grace")
        );

        // Pushing beats reading, and an account that cannot reach it never wins.
        let reach = [
            ("ada", Access::Read),
            ("grace", Access::Refused),
            ("linus", Access::Write),
        ];
        assert_eq!(chosen(&accounts, None, &reach).as_deref(), Some("linus"));
        let reach = [
            ("ada", Access::Hidden),
            ("grace", Access::Refused),
            ("linus", Access::Read),
        ];
        assert_eq!(chosen(&accounts, None, &reach).as_deref(), Some("linus"));

        // None reaches it: the owner, as when nothing is known.
        let reach = [
            ("ada", Access::Hidden),
            ("grace", Access::Refused),
            ("linus", Access::Hidden),
        ];
        assert_eq!(chosen(&accounts, None, &reach).as_deref(), Some("grace"));

        // The account the repository names wins, whatever it can do.
        assert_eq!(
            chosen(&accounts, Some("grace"), &reach).as_deref(),
            Some("grace")
        );
    }
}
