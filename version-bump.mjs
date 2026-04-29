/**
 * Bumps `manifest.json#version` & `versions.json` entries to the version set
 * in `package.json`. Invoked automatically by `npm version` via the
 * `package.json#scripts.version` hook.
 */
import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
  console.error("npm_package_version is not set — run this through `npm version`.");
  process.exit(1);
}

// Update manifest.json
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");

// Append to versions.json (Obsidian uses this to compute minAppVersion back-compat)
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\t") + "\n");

console.log(`Bumped to ${targetVersion} (minAppVersion=${minAppVersion}).`);
