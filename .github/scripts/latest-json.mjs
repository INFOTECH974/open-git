// Writes `latest.json`, the file the installed copies read to update, from the
// signatures attached to a release, and uploads it to that release.
//
//   node .github/scripts/latest-json.mjs v0.2.0 [--dry-run]
//
// Needs `gh`, signed in or with `GH_TOKEN`; the repository comes from
// `GITHUB_REPOSITORY` or from the checkout. The release workflow runs it once,
// after every installer is uploaded: the build jobs run side by side and would
// overwrite each other's entries if each wrote the file.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What each signed file updates: the updater looks for `{os}-{arch}-{bundle}`,
// the way the running copy was installed, then for `{os}-{arch}`. `fallback`
// marks the bundle that answers the short key.
const BUNDLES = [
  { pattern: /_x64-setup\.exe$/, target: "windows-x86_64", bundle: "nsis", fallback: true },
  { pattern: /_x64_[A-Za-z-]+\.msi$/, target: "windows-x86_64", bundle: "msi" },
  { pattern: /_aarch64\.app\.tar\.gz$/, target: "darwin-aarch64", bundle: "app", fallback: true },
  { pattern: /_x64\.app\.tar\.gz$/, target: "darwin-x86_64", bundle: "app", fallback: true },
  { pattern: /_amd64\.AppImage$/, target: "linux-x86_64", bundle: "appimage", fallback: true },
  { pattern: /_amd64\.deb$/, target: "linux-x86_64", bundle: "deb" },
  { pattern: /\.x86_64\.rpm$/, target: "linux-x86_64", bundle: "rpm" },
];

const [tag, ...flags] = process.argv.slice(2);
if (!tag) {
  console.error("usage: latest-json.mjs <tag> [--dry-run]");
  process.exit(2);
}
const dryRun = flags.includes("--dry-run");

const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" });

const repository =
  process.env.GITHUB_REPOSITORY ?? gh("repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner").trim();
const release = JSON.parse(gh("release", "view", tag, "-R", repository, "--json", "assets,body"));
const names = release.assets.map((asset) => asset.name);

const folder = mkdtempSync(join(tmpdir(), "latest-json-"));
gh("release", "download", tag, "-R", repository, "--pattern", "*.sig", "--dir", folder);

const platforms = {};
for (const name of names) {
  const found = BUNDLES.find((bundle) => bundle.pattern.test(name));
  if (!found) continue;
  if (!names.includes(`${name}.sig`)) throw new Error(`${name} has no signature in the release`);
  const entry = {
    signature: readFileSync(join(folder, `${name}.sig`), "utf8"),
    url: `https://github.com/${repository}/releases/download/${tag}/${name}`,
  };
  platforms[`${found.target}-${found.bundle}`] = entry;
  if (found.fallback) platforms[found.target] = entry;
}

// A release that misses a platform would leave its users without the update
// for good: they would only be told again at the next version.
const missing = [...new Set(BUNDLES.map((bundle) => bundle.target))].filter((target) => !platforms[target]);
if (missing.length > 0) throw new Error(`no signed installer in ${tag} for ${missing.join(", ")}`);

const manifest = {
  version: tag.replace(/^v/, ""),
  notes: release.body ?? "",
  pub_date: new Date().toISOString(),
  platforms,
};
const file = join(folder, "latest.json");
writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`latest.json for ${repository} ${tag}:`);
for (const [key, entry] of Object.entries(platforms)) console.log(`  ${key.padEnd(24)} ${entry.url}`);

if (dryRun) {
  console.log(`not uploaded (--dry-run): ${file}`);
} else {
  gh("release", "upload", tag, file, "-R", repository, "--clobber");
  console.log("uploaded");
}
