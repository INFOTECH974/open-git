# gitui — client Git visuel

Clone open source de [GitKraken](https://gitkraken.com), en **Tauri 2 + Rust + React**.

Dépôt : <https://github.com/INFOTECH974/open-git> (`origin`, branche `main`).

Principe : tout ce qui se fait en ligne de commande se fait visuellement. Exemple type : on glisse une branche sur une autre dans le panneau des branches, et l'application propose merge ou rebase, avec aide à la résolution des conflits.

## Fonctionnalités voulues (et leur état)

- **Dépôts** : créer (init), cloner, ouvrir, onglets multi-dépôts, récents. *Fait.*
- **Graphe des commits** avec branches, tags, détail d'un commit et diff. *Fait.*
- **Travail local** : staging (fichier, hunk), commit (amend), branches, tags, stash, discard, ignore. *Fait.*
- **Synchronisation** : fetch, pull, push, avec progression et annulation. *Fait.*
- **Drag & drop** d'une branche sur une autre : merge, rebase, avec gestion des conflits (ours/theirs). *Fait.* Cherry-pick et revert par menu contextuel sur un commit.
- **Compte GitHub** connecté dans l'application (device flow ou jeton personnel). *Fait.*
- **Pull requests** : lister (ouvertes/fermées), créer, extraire la branche. *Fait.*
- **Issues** : lister, créer, commenter, fermer, créer une branche depuis une issue. *Fait.*
- **Interface** : anglais et français, thème système/clair/sombre, panneaux redimensionnables, clavier. *Fait.*
- Plus tard : rebase interactif, blame, worktrees, sous-modules, LFS, GitLab/Gitea, mise à jour automatique.

## Choix techniques décidés

| Sujet | Choix |
|---|---|
| Lecture Git (log, graphe, status, diff, staging) | crate `git2` 0.21, sans ses transports réseau |
| Écriture d'historique et réseau (commit, checkout, merge, rebase, fetch, pull, push, clone, stash…) | binaire `git` de l'utilisateur (`crates/core/src/exec.rs`), pour respecter SSH, credential helpers, hooks, signature, LFS |
| Frontend | React 19 + TypeScript 6, Vite 8, Tailwind v4, shadcn/ui (preset Nova, base Radix), TanStack Virtual, dnd-kit, react-resizable-panels v4, CodeMirror 6 (`@codemirror/merge`) |
| Types partagés Rust → TS | `tauri-specta` 2.0.0-rc.25 (épinglé), bindings générés dans `src/bindings.ts` |
| Connexion GitHub | OAuth App en *device flow* (`GITUI_GITHUB_CLIENT_ID` lu à la compilation, fourni par `.cargo/config.toml` ; un client id est public), plus jeton personnel (PAT) toujours disponible |
| Stockage du jeton | trousseau de l'OS (`keyring`), jamais envoyé au frontend ni écrit sur disque |
| Git HTTPS | l'exécutable se déclare `GIT_ASKPASS` de chaque `git` lancé et répond avec le jeton GitHub du trousseau (`src-tauri/src/askpass.rs`) ; les credential helpers de l'utilisateur passent avant |
| API GitHub | `octocrab` 0.54 sans ses features par défaut (rustls), `reqwest` pour le device flow |
| Rafraîchissement | `notify` surveille `.git` et l'arbre de travail, événement `repositoryChanged` vers l'UI ; fetch automatique en arrière-plan pour les branches distantes (Git n'a pas de notification, les webhooks GitHub exigent un serveur public) |
| Progression | événement `operationProgress` (stderr de `git --progress`), annulation par `CancelToken` |
| i18n | `src/lib/i18n.tsx` : `t("texte anglais")` → dictionnaire `src/lib/locales/fr.ts` ; la clé est le texte anglais |

Architecture en crates :

- `crates/core` (`gitui-core`) : logique Git, sans dépendance à Tauri, testée sur des dépôts temporaires.
- `crates/forge` (`gitui-forge`) : GitHub (jeton, device flow, PR, issues, parsing d'URL, askpass).
- `src-tauri` (`gitui`) : commandes Tauri fines qui appellent `core` et `forge`, watcher, progression, état.

## État actuel (10 octobre 2026)

Toutes les étapes 1 à 6 de la feuille de route sont faites. Vérifié : 44 tests `core` + 6 tests `forge` verts, `cargo clippy --workspace --all-targets` propre (un avertissement cosmétique dans `tests/worktree.rs`), `cargo build -p gitui`, `pnpm build`, parcours rejoués dans le navigateur avec le mock (EN et FR).

### Backend

- `crates/core/src/` : `repo.rs` (`Repo` : `open`, `init`, `clone[_with_progress]`, `info` → `RepoInfo { name, path, head { branch, target, upstream, ahead, behind }, state, author, remotes }`, `refs`, `commit_count`, `graph_rows`, `commit_index`, `search_commits`, `commit_details`, `commit_file_diff`, `commit_file_contents`, `status`, `stage*`/`unstage*`, `add_to_gitignore`, `workdir_file_diff/contents`, `commit(message, amend)`, `checkout`, `fetch/pull/push[_with_progress]`, `fetch_command`/`pull_command`/`push_command`/`background_fetch` → `RemoteCommand` (possède répertoire, environnement et arguments : `run(token, progress)` ou `run_within(timeout)` sans emprunter le `Repo` ; `background_fetch` ajoute `GCM_INTERACTIVE=never`), `remote_names`, `default_remote`), `ops.rs` (branches, tags, `push_branch_command`, `delete_remote_branch_command`, `checkout_commit`, merge/rebase/cherry-pick/revert, `abort_operation`/`continue_operation`, `resolve_conflict(ours|theirs)`, stash list/push/apply/pop/drop, `discard`/`discard_all`, `stage_hunk`/`unstage_hunk` via `git apply --cached`), `status.rs`, `diff.rs` (`hunk_patch`), `contents.rs`, `graph.rs`, `exec.rs` (`git`, `git_with_progress`, `CancelToken` qui tue tout l'arbre de processus, `set_askpass` ; `GIT_TERMINAL_PROMPT=0`, `GIT_EDITOR=:`, pas de fenêtre console sous Windows), `error.rs`.
- Tests `core` : 4 unitaires, `tests/repo.rs` (17, lecture), `tests/worktree.rs` (23 : status, staging, renommages, diffs, commit/amend, checkout, push/fetch/pull contre un dépôt nu, gitignore, branches/tags, conflits de merge abort/resolve/continue, rebase/cherry-pick/revert, stash, discard, hunks, recherche, contenus, init/clone, progression/annulation, fetch en arrière-plan, annulation d'un `git` en cours). Le fixture isole `git` de la config de l'utilisateur (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`, identité, `core.autocrlf=false`).
- `crates/forge/src/` : `token.rs` (keyring `gitui`/`github.com`), `github.rs` (`GitHub::connect`, `account`, `pull_requests`, `create_pull_request`, `issues`, `create_issue`, `comment_issue`, `issue_comments`, `close_issue`), `device.rs` (device flow via reqwest), `remote.rs` (`parse_github_url`), `askpass.rs` (`parse_prompt`, `answer_prompt` : répond `x-access-token` / jeton pour `github.com` et ses sous-domaines, rien sinon). 6 tests.
- `src-tauri/src/` : `lib.rs` (69 commandes `#[tauri::command(async)]`, événements `RepositoryChanged` et `OperationProgress`, mode askpass au démarrage), `commands.rs` (`run_remote` : fetch, pull, push, push d'une branche et suppression d'une branche distante émettent la progression, sont annulables et ne verrouillent pas le dépôt pendant le réseau), `github.rs` (`CLIENT_ID = option_env!("GITUI_GITHUB_CLIENT_ID")`), `state.rs` (un `Arc<Mutex<Repo>>` par chemin, watchers, opérations annulables, session GitHub), `watcher.rs` (debounce 300 ms, ignore `.git/objects|logs|lfs`, `FETCH_HEAD`, `*.lock` et les fichiers ignorés), `progress.rs`, `askpass.rs`, `error.rs` (`AppError::Cancelled` : une annulation n'est pas affichée comme une erreur). CSP durcie dans `tauri.conf.json` (`img-src` autorise les avatars GitHub). Capabilities : `core:default`, `dialog:default`, `opener:default`.
- Les bindings TS sont exportés au démarrage de l'application en debug. Après avoir ajouté ou modifié une commande : lancer `pnpm tauri dev` une fois, ou lancer brièvement `target/debug/gitui.exe` depuis `src-tauri` (le chemin de sortie est relatif à ce dossier).

### Frontend (`src/`)

- `App.tsx` : `I18nProvider` > `GitHubProvider` > `TooltipProvider` > `Shell` (onglets, session restaurée, `OpenMenu` ouvrir/cloner/créer/récents, bandeau de progression du clone, bouton compte GitHub, bouton langue EN/FR, bouton thème). Raccourcis : Ctrl+O, Ctrl+W, Ctrl+Tab.
- `components/RepositoryView.tsx` : un dépôt. Gauche : `RepoHeader` (branche, ↑↓, Fetch/Pull/Push, barre de progression + Annuler) et `RefsPanel` (filtre, double-clic = checkout, drag & drop d'une branche sur une autre → dialogue Merge/Rebase, menus contextuels) puis `ForgePanel` (PR et issues quand `origin` est sur GitHub). Centre : `CommitGraph` (recherche, ligne WIP, navigation clavier, menu contextuel) ou `FileDiffView` (modes Blocs/Unifié/Côte à côte, `CodeDiff.tsx` CodeMirror, stage/unstage par hunk). Droite : `WorkInProgressPanel` (listes, menus contextuels, ignore, discard, stash, ours/theirs, amend, auteur) ou `CommitDetailsPanel`. Bandeau d'opération en cours (merge/rebase/…) avec Continuer/Abandonner. Layout des panneaux dans `localStorage` (`gitui.layout`).
- `hooks/useRepository.ts` : état d'un dépôt, `run(opération, action, "all" | "status")`, écoute `repositoryChanged` (délai de grâce 800 ms après une opération propre) et `operationProgress`, rouvre le dépôt si le backend l'a oublié. Fetch automatique de l'onglet actif (`fetchInBackground` : toutes les 60 s fenêtre visible, à l'ouverture et au retour sur la fenêtre si le dernier date de plus de 10 s) ; silencieux en cas d'échec, ne recharge que si une ref a bougé, et fetch/pull/push attendent qu'il soit fini.
- `lib/` : `api.ts` (wrappers typés + `events`), `github.tsx` (`useGitHub`), `i18n.tsx` (`useI18n` → `{ language, setLanguage, t }` ; langue initiale = `localStorage` puis `navigator.language`), `locales/fr.ts`, `format.ts` (`setLocale` pour `Intl`), `ignore.ts`, `recent.ts`, `session.ts`, `theme.ts`.
- `dev/mock.ts` : faux backend complet (`mockIPC` avec `shouldMockEvents: true`, événements émis via `emit`) chargé seulement par `pnpm dev` hors Tauri : historique, arbre de travail, stash, branches, conflit de merge sur `origin/production`, progression, GitHub fictif, trois chemins fictifs pour les onglets.

### Intégration continue et livraison

- `.github/workflows/ci.yml` : tests `core` + `forge`, clippy, build de `gitui`, `cargo fmt --check` (Ubuntu et Windows) ; `pnpm build`.
- `.github/workflows/release.yml` : sur un tag `v*`, `tauri-action` construit les installeurs Windows/macOS/Linux et crée une release GitHub en brouillon. Le secret optionnel `GITUI_GITHUB_CLIENT_ID` active « Se connecter avec GitHub ».
- Localement : `pnpm tauri build` produit les installeurs dans `target/release/bundle/` (NSIS et MSI sous Windows).

### Vérifié / non vérifié

- Vérifié dans le navigateur avec le mock : onglets, récents, WIP/staging/commit, push, checkout, ignore, recherche, menus et dialogues des branches, bandeau de conflit, thème, stash, discard, clone, CodeMirror unifié/côte à côte, progression du fetch, drag & drop merge, résolution « garder la leur » + Continuer, connexion GitHub, PR/issues, branche depuis une issue, bascule EN/FR.
- Mode askpass vérifié en ligne de commande (`GITUI_ASKPASS=1 gitui.exe "Username for 'https://github.com': "` sort sans fenêtre).
- **Non vérifié dans la vraie fenêtre Tauri** : tout ce qui est postérieur au graphe (Thomas n'a essayé que l'étape 1 sur `sovazprint`). Les opérations Git sont couvertes par les tests Rust qui lancent le vrai `git`. L'API GitHub réelle n'a pas été appelée.

## Feuille de route

1. ~~Ouvrir un dépôt, graphe, détail et diff d'un commit.~~
2. ~~Staging (fichier, hunk), commit, branches, stash.~~
3. ~~Compte GitHub, init, clone, fetch, pull, push.~~
4. ~~Drag & drop : merge, rebase, conflits.~~ Cherry-pick et revert par menu.
5. ~~PR GitHub.~~
6. ~~Issues GitHub, avec création de branche depuis une issue.~~
7. Plus tard : rebase interactif, blame, worktrees, LFS, sous-modules, GitLab, Gitea.

## Prochaine session

- **Essayer la vraie fenêtre** (`pnpm tauri dev`) sur un dépôt réel : staging, commit, push, conflit, connexion GitHub avec un PAT, PR/issues. Corriger ce qui diffère du mock.
- **Mise à jour automatique** : `tauri-plugin-updater` demande une paire de clés (`pnpm tauri signer generate`) et un point de terminaison ; décision de Thomas.
- **Nom et licence** (voir Décisions ouvertes), puis publier un premier tag `v0.1.0` pour tester `release.yml`.
- Requêtes conditionnelles (ETag) et cache pour l'API GitHub ; rendu Markdown des corps d'issues (la CSP est prête).
- Askpass pour d'autres hôtes : aujourd'hui seul GitHub est servi ; un dialogue d'identifiants dans l'UI serait le pas suivant.
- Rebase interactif, blame, worktrees.

## Pièges connus

- **Annulation** : `child.kill()` ne tue que le premier processus. `git` délègue le réseau à des helpers (et `cmd\git.exe` sous Windows n'est qu'un lanceur du vrai `git.exe`), qui gardent les pipes ouverts jusqu'à la fin du transfert. `kill_tree` utilise `taskkill /T /F` sous Windows et, sous Unix, `kill -KILL -<pgid>` sur le groupe créé par `process_group(0)`.
- **Commandes Tauri** : une commande non `async` s'exécute sur le thread principal et fige l'UI. Utiliser `#[tauri::command(async)]` pour tout appel Git.
- **`cargo test -p gitui`** échoue sous Windows au chargement du binaire de test (`STATUS_ENTRYPOINT_NOT_FOUND`). Les tests vivent dans `gitui-core` et `gitui-forge` ; ne pas mettre de `#[test]` dans `src-tauri`.
- **Heredoc Bash** : écrire du Rust/TS via un heredoc transforme `\n`, `\r` en vrais retours à la ligne. Écrire les fichiers de code avec les outils Write/Edit.
- **git2 0.21** : `StringArray::iter()` renvoie des `Result<Option<&str>>` ; `Remote::url()` renvoie un `Result`.
- **Statuts libgit2** : ordre insensible à la casse sous Windows ; `status()` retrie en ASCII.
- **Dépôt nu de test** : `Repository::init_bare` pointe HEAD sur `master` ; mettre `set_head("refs/heads/main")` avant de cloner.
- **`core.autocrlf`** : libgit2 lit la config globale alors que le `git` isolé des tests ne la lit pas ; le fixture force `core.autocrlf=false`.
- **octocrab** : ses features par défaut tirent `jwt-aws-lc-rs` → `aws-lc-sys` exige NASM sous Windows. Garder `default-features = false` avec `default-client`, `follow-redirect`, `retry`, `rustls`, `rustls-ring`, `timeout`. `keyring` 4 n'a que les features `default`/`v1`/`cli`.
- **Askpass** : `GIT_ASKPASS` ne reçoit que le prompt en argument, d'où la variable `GITUI_ASKPASS` dans l'environnement du `git` enfant pour reconnaître le mode. Sous Windows en release (`windows_subsystem = "windows"`) l'écriture sur stdout fonctionne car `git` fournit un pipe. Git Credential Manager, s'il est configuré, passe avant et affiche sa propre fenêtre.
- **Drag & drop sous Windows** : le HTML5 natif est intercepté par `dragDropEnabled` ; dnd-kit (pointer events) avec `activationConstraint: { distance: 6 }` pour ne pas gêner clic et double-clic.
- **Version de Tauri** : `cargo search tauri` remonte une 3.0 alpha. Rester sur la 2.x (verrouillé en 2.12). Idem pour les plugins.
- **specta** : `i64`/`u64` refusés par défaut ; le builder appelle `dangerously_cast_bigints_to_number()`. Un argument de commande de type enum doit dériver `Deserialize`.
- **TypeScript 6** : `baseUrl` est déprécié et fait échouer `tsc` ; l'alias `@/*` passe uniquement par `paths`. `lib` est ES2020 : pas de `replaceAll`.
- **react-resizable-panels v4** : API `orientation`, `defaultLayout`, `onLayoutChanged` (pas `direction`/`onLayout`).
- **lucide-react 1.x** : plus d'icônes de marques (pas de logo GitHub) ; `CircleUser` à la place.
- **Mock et événements** : `mockIPC(handler, { shouldMockEvents: true })` et `emit` de `@tauri-apps/api/event`, sinon `listen` ne reçoit rien.
- **Tests dans le panneau navigateur caché** : captures d'écran en timeout, `scroll` programmatique à compléter par `el.dispatchEvent(new Event("scroll"))`, overlays Radix fermés qui restent dans le DOM (les retirer en JS avant de cliquer), `find` qui matche aussi `title`. Les « Invalid hook call » en console sont des artefacts HMR, pas un double React.
- **shadcn CLI** : `pnpm dlx shadcn@latest init -t vite -b radix -p nova -y`. Composants ajoutés : button, badge, scroll-area, separator, tooltip, dropdown-menu, context-menu, dialog, alert-dialog, resizable, checkbox, input, label.
- **Raccourcis dans le webview** : Ctrl+W est capté par l'application (ferme l'onglet).
- **Vite** : `crates/` et `target/` sont exclus du watcher dans `vite.config.ts`, sinon erreurs `EBUSY` pendant la compilation Rust.

## Décisions ouvertes

- **Nom** : `gitui` est déjà celui d'un client Git en terminal connu, publié sur crates.io. À changer avant toute publication.
- **Licence** : non choisie.
- **Identifiant** de l'application : `app.gitui.desktop` est provisoire.
- Ne pas reprendre le nom, le logo ni les éléments graphiques de GitKraken.

## Commandes

```bash
pnpm install
pnpm tauri dev                 # application complète (régénère src/bindings.ts)
pnpm dev                       # UI seule dans le navigateur, avec le mock
cargo test -p gitui-core -p gitui-forge
cargo clippy --workspace --all-targets
cargo fmt --all
cargo run -p gitui-core --example dump -- ../un-depot 20
pnpm build                     # tsc + vite build
pnpm tauri build               # installeurs dans target/release/bundle/
```
