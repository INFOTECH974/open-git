# Open GIT — client Git visuel

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
- **Assistant de message de commit** : un modèle rédige le résumé et la description à partir du diff indexé. Quatre fournisseurs : les CLI installés `claude` (Claude Code) et `codex`, avec le compte auquel ils sont connectés, ou les API Anthropic et OpenAI avec la clé de l'utilisateur. *Fait.*
- **Interface** : anglais et français, thème système/clair/sombre, panneaux redimensionnables, clavier. *Fait.*
- **Mise à jour de l'application** : une copie installée regarde la dernière release GitHub, la télécharge, vérifie sa signature, l'installe et redémarre. *Fait, pas encore essayé contre une vraie release.*
- Plus tard : rebase interactif, blame, worktrees, sous-modules, LFS, GitLab/Gitea.

## Choix techniques décidés

| Sujet | Choix |
|---|---|
| Lecture Git (log, graphe, status, diff, staging) | crate `git2` 0.21, sans ses transports réseau |
| Écriture d'historique et réseau (commit, checkout, merge, rebase, fetch, pull, push, clone, stash…) | binaire `git` de l'utilisateur (`crates/core/src/exec.rs`), pour respecter SSH, credential helpers, hooks, signature, LFS |
| Frontend | React 19 + TypeScript 6, Vite 8, Tailwind v4, shadcn/ui (preset Nova, base Radix), TanStack Virtual, dnd-kit, react-resizable-panels v4, CodeMirror 6 (`@codemirror/merge`) |
| Types partagés Rust → TS | `tauri-specta` 2.0.0-rc.25 (épinglé), bindings générés dans `src/bindings.ts` |
| Connexion GitHub | OAuth App en *device flow* (`OPEN_GIT_GITHUB_CLIENT_ID` lu à la compilation, fourni par `.cargo/config.toml` ; un client id est public), plus jeton personnel (PAT) toujours disponible |
| Stockage du jeton | trousseau de l'OS (`keyring`), jamais envoyé au frontend ni écrit sur disque |
| Git HTTPS | l'exécutable se déclare `GIT_ASKPASS` de chaque `git` lancé et répond avec le jeton GitHub du trousseau (`src-tauri/src/askpass.rs`) ; les credential helpers de l'utilisateur passent avant |
| API GitHub | `octocrab` 0.54 sans ses features par défaut (rustls), `reqwest` pour le device flow |
| Assistant IA | crate `open-git-ai`. Par CLI, comme pour `git` : `claude -p` et `codex exec` lancés sans terminal, prompt sur stdin, dans un dossier vide, sans outil (`claude --tools ""`) ou en bac à sable lecture seule (`codex --sandbox read-only`). Pas d'OAuth : Anthropic et OpenAI n'en proposent pas aux applications tierces. Par API : appels HTTP directs (`reqwest`, pas de SDK Rust officiel) à l'API Messages d'Anthropic et aux Chat Completions d'OpenAI ; clés dans le trousseau (`open-git` / `api.anthropic.com`, `api.openai.com`), jamais envoyées au frontend. Fournisseur et modèles choisis dans `localStorage` (`open-git.ai`) ; par défaut Claude Code, modèle vide = celui du CLI, `claude-opus-5-5` pour l'API Anthropic |
| Rafraîchissement | `notify` surveille `.git` et l'arbre de travail, événement `repositoryChanged` vers l'UI ; fetch automatique en arrière-plan pour les branches distantes (Git n'a pas de notification, les webhooks GitHub exigent un serveur public) |
| Mise à jour | `tauri-plugin-updater` 2.x, appelé depuis Rust (`src-tauri/src/update.rs`), sans permission accordée au frontend. Point de terminaison : `https://github.com/INFOTECH974/open-git/releases/latest/download/latest.json`, écrit par `tauri-action`. Installeurs signés (minisign) : clé publique dans `tauri.conf.json`, clé privée sans mot de passe dans `~/.tauri/open-git.key` chez Thomas et dans le secret `TAURI_SIGNING_PRIVATE_KEY` du dépôt. La perdre empêche à jamais de mettre à jour les copies installées |
| Progression | événement `operationProgress` (stderr de `git --progress`), annulation par `CancelToken` |
| i18n | `src/lib/i18n.tsx` : `t("texte anglais")` → dictionnaire `src/lib/locales/fr.ts` ; la clé est le texte anglais |

Architecture en crates :

- `crates/core` (`open-git-core`) : logique Git, sans dépendance à Tauri, testée sur des dépôts temporaires.
- `crates/forge` (`open-git-forge`) : GitHub (jeton, device flow, PR, issues, parsing d'URL, askpass).
- `crates/ai` (`open-git-ai`) : assistant de message de commit (clés d'API, fournisseurs, prompt), sans dépendance à `core` ni à Tauri.
- `src-tauri` (`open-git`, binaire `open-git.exe`) : commandes Tauri fines qui appellent `core`, `forge` et `ai`, watcher, progression, état.

## État actuel (12 octobre 2026)

Toutes les étapes 1 à 6 de la feuille de route sont faites, plus l'assistant de message de commit et la mise à jour de l'application. Vérifié : 45 tests `core` + 6 tests `forge` + 19 tests `ai` verts, `cargo clippy --workspace --all-targets` propre (un avertissement cosmétique dans `tests/worktree.rs`), `cargo build -p open-git`, `pnpm build`, parcours rejoués dans le navigateur avec le mock (EN et FR).

### Backend

- `crates/core/src/` : `repo.rs` (`Repo` : `open`, `init`, `clone[_with_progress]`, `info` → `RepoInfo { name, path, head { branch, target, upstream, ahead, behind }, state, author, remotes }`, `refs`, `commit_count`, `graph_rows`, `commit_index`, `search_commits`, `commit_details`, `commit_file_diff`, `commit_file_contents`, `status`, `stage*`/`unstage*`, `add_to_gitignore`, `workdir_file_diff/contents`, `commit(message, amend)`, `checkout`, `fetch/pull/push[_with_progress]`, `fetch_command`/`pull_command`/`push_command`/`background_fetch` → `RemoteCommand` (possède répertoire, environnement et arguments : `run(token, progress)` ou `run_within(timeout)` sans emprunter le `Repo` ; `background_fetch` ajoute `GCM_INTERACTIVE=never`), `remote_names`, `default_remote`), `ops.rs` (branches, tags, `push_branch_command`, `delete_remote_branch_command`, `checkout_commit`, merge/rebase/cherry-pick/revert, `abort_operation`/`continue_operation`, `resolve_conflict(ours|theirs)`, stash list/push/apply/pop/drop, `discard`/`discard_all`, `stage_hunk`/`unstage_hunk` via `git apply --cached`), `status.rs`, `diff.rs` (`hunk_patch`), `contents.rs`, `graph.rs`, `exec.rs` (`git`, `git_with_progress`, `CancelToken` qui tue tout l'arbre de processus, `set_askpass` ; `GIT_TERMINAL_PROMPT=0`, `GIT_EDITOR=:`, pas de fenêtre console sous Windows), `error.rs`.
- `Repo::staged_changes(amend)` → `StagedChanges { files (name-status), patch, recent_subjects }` : ce que le commit contiendrait, pour l'assistant (`git diff --cached`, contre le parent de `HEAD` avec `amend`).
- Tests `core` : 4 unitaires, `tests/repo.rs` (17, lecture), `tests/worktree.rs` (24 : status, staging, renommages, diffs, commit/amend, checkout, push/fetch/pull contre un dépôt nu, gitignore, branches/tags, conflits de merge abort/resolve/continue, rebase/cherry-pick/revert, stash, discard, hunks, recherche, contenus, init/clone, progression/annulation, fetch en arrière-plan, annulation d'un `git` en cours). Le fixture isole `git` de la config de l'utilisateur (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`, identité, `core.autocrlf=false`).
- `crates/forge/src/` : `token.rs` (keyring `open-git`/`github.com`), `github.rs` (`GitHub::connect`, `account`, `repositories` (ce que le compte peut cloner : propriétaire, collaborateur, organisations ; 1000 au plus, triés par dernier push), `pull_requests`, `create_pull_request`, `issues`, `create_issue`, `comment_issue`, `issue_comments`, `close_issue`), `device.rs` (device flow via reqwest), `remote.rs` (`parse_github_url`), `askpass.rs` (`parse_prompt`, `answer_prompt` : répond `x-access-token` / jeton pour `github.com` et ses sous-domaines, rien sinon). 6 tests.
- `crates/ai/src/` : `cli.rs` (`cli_available` : cherche `claude`/`codex` sur le `PATH` puis dans `~/.local/bin`, `%APPDATA%\npm`, `/opt/homebrew/bin`… ; `cli_models` ; `complete` via `tokio::process`, délai de 180 s, `taskkill /T` sous Windows ; `claude` répond en JSON (`result`, `is_error`), `codex` écrit sa réponse dans le fichier donné à `-o` et ses erreurs sur des lignes `ERROR:` de stderr), `key.rs` (trousseau, une clé par fournisseur d'API), `provider.rs` (`Provider { Anthropic, OpenAi, ClaudeCode, Codex }` sérialisé en minuscules, `program()` pour les CLI, `list_models` (sert aussi à valider une clé), `complete` ; côté Anthropic : `effort: low` si le modèle l'accepte (lu dans `GET /v1/models/{id}`), `fallbacks: "default"` + en-tête bêta `server-side-fallback-2026-07-01` pour les modèles qui l'acceptent, `stop_reason` `refusal`/`max_tokens` traités comme des erreurs), `commit.rs` (prompt système, `shorten` : 12 000 caractères de diff par fichier, 100 000 au total, fichiers de verrouillage et `.min.` envoyés par leur nom seul ; `CommitSuggestion { summary, body, shortened_files }`). 19 tests unitaires, sans réseau ni CLI. Exemple : `cargo run -p open-git-ai --example suggest -- claude default ../un-depot` (ou `codex default`, `anthropic claude-opus-5-5`, `openai <modèle>`).
- `src-tauri/src/ai.rs` : `ai_providers` (fournisseurs utilisables : clé enregistrée ou CLI trouvé), `ai_save_key` (valide la clé en listant les modèles, puis l'enregistre), `ai_clear_key`, `ai_models`, `ai_commit_message` (le dépôt n'est verrouillé que pendant la lecture du diff). `AppError::Ai`.
- `src-tauri/src/update.rs` : `update_check` (version de la dernière release si elle est plus récente, sinon `null`), `update_install` (revérifie, télécharge en émettant `UpdateProgress { percent }`, installe, `app.restart()` ; ne rend la main qu'en cas d'échec). `AppError::Update`.
- `src-tauri/src/` : `lib.rs` (77 commandes `#[tauri::command(async)]`, événements `RepositoryChanged`, `OperationProgress` et `UpdateProgress`, mode askpass au démarrage), `commands.rs` (`run_remote` : fetch, pull, push, push d'une branche et suppression d'une branche distante émettent la progression, sont annulables et ne verrouillent pas le dépôt pendant le réseau), `github.rs` (`CLIENT_ID = option_env!("OPEN_GIT_GITHUB_CLIENT_ID")`), `state.rs` (un `Arc<Mutex<Repo>>` par chemin, watchers, opérations annulables, session GitHub), `watcher.rs` (debounce 300 ms, ignore `.git/objects|logs|lfs`, `FETCH_HEAD`, `*.lock` et les fichiers ignorés), `progress.rs`, `askpass.rs`, `error.rs` (`AppError::Cancelled` : une annulation n'est pas affichée comme une erreur). CSP durcie dans `tauri.conf.json` (`img-src` autorise les avatars GitHub). Capabilities : `core:default`, `dialog:default`, `opener:default`.
- Les bindings TS sont exportés au démarrage de l'application en debug. Après avoir ajouté ou modifié une commande : lancer `pnpm tauri dev` une fois, ou lancer brièvement `target/debug/open-git.exe` depuis `src-tauri` (le chemin de sortie est relatif à ce dossier).

### Frontend (`src/`)

- `App.tsx` : `I18nProvider` > `GitHubProvider` > `TooltipProvider` > `Shell` (onglets, session restaurée, `OpenMenu` ouvrir/cloner/créer/récents, `dialogs/CloneDialog.tsx` (liste filtrable des dépôts GitHub du compte ou URL libre, dossier mémorisé, puis barre de progression avec Masquer/Annuler ; l'erreur d'un clone raté s'affiche dans le dialogue), bandeau de progression quand le dialogue est masqué, bouton compte GitHub, bouton langue EN/FR, bouton thème). Raccourcis : Ctrl+O, Ctrl+W, Ctrl+Tab.
- `components/RepositoryView.tsx` : un dépôt. Gauche : `RepoHeader` (branche, ↑↓, Fetch/Pull/Push, barre de progression + Annuler) et `RefsPanel` (filtre, double-clic = checkout, drag & drop d'une branche sur une autre → dialogue Merge/Rebase, menus contextuels) puis `ForgePanel` (PR et issues quand `origin` est sur GitHub). Centre : `CommitGraph` (recherche, ligne WIP, navigation clavier, menu contextuel) ou `FileDiffView` (modes Blocs/Unifié/Côte à côte, `CodeDiff.tsx` CodeMirror, stage/unstage par hunk). Droite : `WorkInProgressPanel` (listes, menus contextuels, ignore, discard, stash, ours/theirs, amend, auteur) ou `CommitDetailsPanel`. Bandeau d'opération en cours (merge/rebase/…) avec Continuer/Abandonner. Layout des panneaux dans `localStorage` (`open-git.layout`).
- `hooks/useRepository.ts` : état d'un dépôt, `run(opération, action, "all" | "status")`, écoute `repositoryChanged` (délai de grâce 800 ms après une opération propre) et `operationProgress`, rouvre le dépôt si le backend l'a oublié. Fetch automatique de l'onglet actif (`fetchInBackground` : toutes les 60 s fenêtre visible, à l'ouverture et au retour sur la fenêtre si le dernier date de plus de 10 s) ; silencieux en cas d'échec, ne recharge que si une ref a bougé, et fetch/pull/push attendent qu'il soit fini.
- Assistant IA : `lib/ai.tsx` (`AiProvider`/`useAi` : fournisseur, modèles, fournisseurs utilisables, `refresh`, dialogue), `components/AiSettingsDialog.tsx` (quatre fournisseurs avec pastille verte quand ils sont prêts ; pour un CLI : trouvé ou « Chercher à nouveau », pour une API : la clé ; puis le modèle), bouton étincelles dans la barre du haut et à droite du champ Résumé de `WorkInProgressPanel` (ouvre les réglages tant que rien n'est configuré, sinon remplit Résumé et Description ; signale les diffs raccourcis).
- Mise à jour : `lib/update.tsx` (`UpdateProvider`/`useUpdate` : version courante par `getVersion()`, recherche silencieuse au démarrage puis toutes les 4 h, recherche à la demande qui affiche ses erreurs, installation avec pourcentage), `components/UpdateDialog.tsx` (« À propos » : version, « Rechercher des mises à jour », puis « Installer et redémarrer » avec barre de progression et lien vers la release). Le nom « Open GIT » en haut à gauche ouvre ce dialogue ; un bouton vert « Mettre à jour » apparaît dans la barre du haut dès qu'une version est disponible.
- `lib/` : `api.ts` (wrappers typés + `events`), `cloneProgress.ts` (`overallCloneProgress` ramène les phases de `git clone` à un seul pourcentage), `github.tsx` (`useGitHub`), `i18n.tsx` (`useI18n` → `{ language, setLanguage, t }` ; langue initiale = `localStorage` puis `navigator.language`), `locales/fr.ts`, `format.ts` (`setLocale` pour `Intl`), `ignore.ts`, `recent.ts`, `session.ts`, `theme.ts`.
- `dev/mock.ts` : faux backend complet (`mockIPC` avec `shouldMockEvents: true`, événements émis via `emit`) chargé seulement par `pnpm dev` hors Tauri : historique, arbre de travail, stash, branches, conflit de merge sur `origin/production`, progression, GitHub fictif (compte, dépôts à cloner, PR, issues), trois chemins fictifs pour les onglets.

### Intégration continue et livraison

- `.github/workflows/ci.yml` : tests `core` + `forge` + `ai`, clippy, build de `open-git`, `cargo fmt --check` (Ubuntu et Windows) ; `pnpm build`.
- `.github/workflows/release.yml` : sur un tag `v*`, un premier job refuse le tag s'il diffère de la `version` de `tauri.conf.json`, puis `tauri-action` construit les installeurs Windows/macOS/Linux, les signe pour la mise à jour (secret `TAURI_SIGNING_PRIVATE_KEY`), écrit `latest.json` et crée une release GitHub en brouillon. Les copies installées ne voient la mise à jour qu'une fois le brouillon publié (`releases/latest` ignore brouillons et préversions). Le client id GitHub vient de `.cargo/config.toml`.
- Publier une version : monter la version dans `src-tauri/tauri.conf.json` (celle qui compte), `Cargo.toml` (workspace) et `package.json` ; commit ; `git tag v0.2.0 && git push origin main v0.2.0` ; publier le brouillon quand le workflow a fini.
- Localement : `pnpm tauri build` produit les installeurs dans `target/release/bundle/` (NSIS et MSI sous Windows).

### Vérifié / non vérifié

- Vérifié dans le navigateur avec le mock : onglets, récents, WIP/staging/commit, push, checkout, ignore, recherche, menus et dialogues des branches, bandeau de conflit, thème, stash, discard, clone, CodeMirror unifié/côte à côte, progression du fetch, drag & drop merge, résolution « garder la leur » + Continuer, connexion GitHub, PR/issues, branche depuis une issue, bascule EN/FR, assistant IA (clé refusée, clé acceptée, CLI trouvé ou introuvable, choix du modèle, génération, erreur du CLI).
- Mode askpass vérifié en ligne de commande (`OPEN_GIT_ASKPASS=1 open-git.exe "Username for 'https://github.com': "` sort sans fenêtre).
- **Non vérifié dans la vraie fenêtre Tauri** : tout ce qui est postérieur au graphe (Thomas n'a essayé que l'étape 1 sur `sovazprint`). Les opérations Git sont couvertes par les tests Rust qui lancent le vrai `git`. API GitHub réelle : la connexion par device flow et la liste des dépôts ont été essayées (`cargo run -p open-git-forge --example repositories`) ; PR et issues pas encore.

- **Mise à jour** : vérifié avec le mock (à jour, recherche, version disponible, bouton de la barre du haut, téléchargement avec pourcentage, erreur d'installation) et par un vrai `pnpm tauri build` signé, qui produit `Open GIT_0.1.0_x64-setup.exe.sig` et le `.msi.sig`. **Pas essayé : le workflow de release (aucun tag n'a encore été poussé), `latest.json`, et la mise à jour réelle d'une copie installée**.
- **Assistant IA, côté API : aucun appel réel réussi.** Les requêtes Anthropic et OpenAI sont écrites d'après la documentation et couvertes par des tests sans réseau ; seul le chemin d'erreur (401, clé invalide) a été vu contre la vraie API Anthropic. À essayer avec une vraie clé, pour les deux.
- **Assistant IA, côté CLI** : les deux programmes ont été lancés pour de bon par l'exemple `suggest` (Claude Code 2.1.291, Codex 0.151.0), mais sur la machine de Thomas ils échouent tous les deux, et l'erreur remonte correctement : `claude` s'authentifie avec une `ANTHROPIC_API_KEY` invalide posée dans `~/.claude/settings.json` (elle passe avant la connexion claude.ai), `codex` a pour modèle par défaut `gpt-6-astra`, refusé avec un compte ChatGPT. La même commande `claude`, lancée à la main avec `--setting-sources ""`, a rendu un message correct en 5 s. Pas essayé : une installation npm (`claude.cmd`), macOS et Linux.

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
- **Assistant IA** : l'essayer dans la vraie fenêtre une fois les réglages de `claude` et de `codex` corrigés (voir Non vérifié), puis avec une vraie clé Anthropic et OpenAI. Suites possibles : streaming de la réponse, annulation, description de PR, URL de base libre pour un serveur compatible OpenAI (Ollama…).
- **Mise à jour automatique, à finir côté GitHub** : (1) enregistrer la clé privée comme secret du dépôt (`gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/open-git.key`) ; (2) committer et pousser le travail en attente (le dépôt est public depuis le 12 octobre 2026, condition pour que `latest.json` soit servi sans authentification) ; (3) publier `v0.1.0`, l'installer, puis publier `v0.1.1` pour voir la mise à jour de bout en bout.
- **Licence** (voir Décisions ouvertes) : le dépôt est public sans licence, donc personne n'a formellement le droit de réutiliser le code.
- Requêtes conditionnelles (ETag) et cache pour l'API GitHub ; rendu Markdown des corps d'issues (la CSP est prête).
- Askpass pour d'autres hôtes : aujourd'hui seul GitHub est servi ; un dialogue d'identifiants dans l'UI serait le pas suivant.
- Rebase interactif, blame, worktrees.

## Pièges connus

- **Annulation** : `child.kill()` ne tue que le premier processus. `git` délègue le réseau à des helpers (et `cmd\git.exe` sous Windows n'est qu'un lanceur du vrai `git.exe`), qui gardent les pipes ouverts jusqu'à la fin du transfert. `kill_tree` utilise `taskkill /T /F` sous Windows et, sous Unix, `libc::killpg` sur le groupe créé par `process_group(0)` (pas la commande `kill` externe : sa syntaxe pour un groupe varie selon les systèmes).
- **Chemins temporaires dans les tests** : sur le runner Windows de la CI, `TEMP` est en forme courte (`RUNNER~1`) alors que libgit2 renvoie la forme longue. Comparer des chemins après `fs::canonicalize`.
- **Commandes Tauri** : une commande non `async` s'exécute sur le thread principal et fige l'UI. Utiliser `#[tauri::command(async)]` pour tout appel Git.
- **`cargo test -p open-git`** échoue sous Windows au chargement du binaire de test (`STATUS_ENTRYPOINT_NOT_FOUND`). Les tests vivent dans `open-git-core` et `open-git-forge` ; ne pas mettre de `#[test]` dans `src-tauri`.
- **Heredoc Bash** : écrire du Rust/TS via un heredoc transforme `\n`, `\r` en vrais retours à la ligne. Écrire les fichiers de code avec les outils Write/Edit.
- **git2 0.21** : `StringArray::iter()` renvoie des `Result<Option<&str>>` ; `Remote::url()` renvoie un `Result`.
- **Statuts libgit2** : ordre insensible à la casse sous Windows ; `status()` retrie en ASCII.
- **Dépôt nu de test** : `Repository::init_bare` pointe HEAD sur `master` ; mettre `set_head("refs/heads/main")` avant de cloner.
- **`core.autocrlf`** : libgit2 lit la config globale alors que le `git` isolé des tests ne la lit pas ; le fixture force `core.autocrlf=false`.
- **octocrab** : ses features par défaut tirent `jwt-aws-lc-rs` → `aws-lc-sys` exige NASM sous Windows. Garder `default-features = false` avec `default-client`, `follow-redirect`, `retry`, `rustls`, `rustls-ring`, `timeout`. `keyring` 4 n'a que les features `default`/`v1`/`cli`.
- **`claude -p`** : sans `CLAUDE_CODE_MAX_RETRIES`, une authentification refusée est retentée une dizaine de fois, soit plusieurs minutes de silence. Les réglages utilisateur s'appliquent (y compris un `env.ANTHROPIC_API_KEY` de `settings.json`, prioritaire sur la connexion claude.ai) ; `--safe-mode` et `--strict-mcp-config` écartent hooks, plugins et serveurs MCP, qui ralentissent le démarrage. Le prompt système passé en argument tient sur une ligne, car une installation npm passe par un `.cmd` qui ne transmet pas les retours à la ligne ; les vraies consignes partent sur stdin. Lancé depuis une session Claude Code, il hérite de ses variables `CLAUDE_CODE_*` : essayer dans un environnement propre.
- **`codex exec`** : démarre en une dizaine de secondes (hooks, skills et serveurs MCP de l'utilisateur ; `-c mcp_servers={}` ne les retire pas). Sa sortie standard reste vide : la réponse est dans le fichier de `-o`.
- **API Anthropic** : sur Claude Opus 5.5 la réflexion ne se désactive pas (`thinking: disabled` → 400) et elle compte dans `max_tokens`, d'où 16 000 ; on règle la profondeur avec `output_config.effort`. Un refus arrive en HTTP 200 avec `stop_reason: "refusal"`. `fallbacks` n'est accepté que par certains modèles (liste `FALLBACK_MODELS`), pas par Haiku.
- **API OpenAI** : `GET /v1/models` liste aussi embeddings, audio, images ; `NOT_CHAT` les écarte par mots-clés. Pas de modèle par défaut : l'utilisateur choisit dans la liste.
- **Askpass** : `GIT_ASKPASS` ne reçoit que le prompt en argument, d'où la variable `OPEN_GIT_ASKPASS` dans l'environnement du `git` enfant pour reconnaître le mode. Sous Windows en release (`windows_subsystem = "windows"`) l'écriture sur stdout fonctionne car `git` fournit un pipe. Git Credential Manager, s'il est configuré, passe avant et affiche sa propre fenêtre.
- **Drag & drop sous Windows** : le HTML5 natif est intercepté par `dragDropEnabled` ; dnd-kit (pointer events) avec `activationConstraint: { distance: 6 }` pour ne pas gêner clic et double-clic.
- **Version de Tauri** : `cargo search tauri` remonte une 3.0 alpha. Rester sur la 2.x (verrouillé en 2.12). Idem pour les plugins.
- **Mise à jour et version** : l'application compare sa propre version à celle de `latest.json`, toutes deux issues de `tauri.conf.json`. Un tag poussé sans monter cette version ne met personne à jour (le workflow le refuse). `latest.json` n'est servi que pour une release publiée, et seulement si le dépôt est public.
- **Mise à jour et clé** : avec `createUpdaterArtifacts`, `pnpm tauri build` veut `TAURI_SIGNING_PRIVATE_KEY` (chemin ou contenu de la clé) : sans elle les installeurs sont quand même produits, puis la commande échoue (« A public key has been found, but no private key », code 1) sans écrire les `.sig`. La clé n'a pas de mot de passe : il faut quand même que `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` existe et soit vide, sinon le build demande un mot de passe ; or PowerShell supprime une variable qu'on met à vide (`$env:X = ""`). Depuis Git Bash : `TAURI_SIGNING_PRIVATE_KEY=~/.tauri/open-git.key TAURI_SIGNING_PRIVATE_KEY_PASSWORD= pnpm tauri build`.
- **Mise à jour par plateforme** : sous Windows l'installeur ferme l'application et la relance lui-même ; sous Linux seul l'AppImage se met à jour (pas `.deb`/`.rpm`) ; sous macOS l'application n'est pas signée par Apple.
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

- **Nom** : décidé, « Open GIT » (paquets `open-git`, `open-git-core`, `open-git-forge` ; préfixe `OPEN_GIT_` pour les variables d'environnement, `open-git.` pour le `localStorage`). L'ancien nom `gitui` était celui d'un client Git en terminal connu. Le dossier de travail local s'appelle encore `gitui`.
- **Licence** : non choisie.
- **Identifiant** de l'application : `com.infotech974.opengit`, choisi au premier build installable. Le changer plus tard crée une autre application aux yeux du système (réglages et installation séparés).
- **Icône** : `src-tauri/icons/icon.svg` est la source ; `pnpm tauri icon src-tauri/icons/icon.svg` régénère les tailles.
- Ne pas reprendre le nom, le logo ni les éléments graphiques de GitKraken.

## Commandes

```bash
pnpm install
pnpm tauri dev                 # application complète (régénère src/bindings.ts)
pnpm dev                       # UI seule dans le navigateur, avec le mock
cargo test -p open-git-core -p open-git-forge -p open-git-ai
cargo clippy --workspace --all-targets
cargo fmt --all
cargo run -p open-git-core --example dump -- ../un-depot 20
cargo run -p open-git-forge --example repositories -- 10   # vrais dépôts du compte du trousseau
cargo run -p open-git-ai --example suggest -- claude default .   # message pour ce qui est indexé (ou codex, anthropic, openai)
pnpm build                     # tsc + vite build
pnpm tauri build               # installeurs dans target/release/bundle/ (demande la clé de signature, voir Pièges connus)
```
