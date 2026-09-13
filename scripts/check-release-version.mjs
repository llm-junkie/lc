/**
 * Keep the three application manifests and a release tag on one version.
 *
 * Usage:
 *   node scripts/check-release-version.mjs
 *   node scripts/check-release-version.mjs v1.2.3
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));

const packageVersion = readJson('package.json').version;
const tauriVersion = readJson('src-tauri/tauri.conf.json').version;
const cargoToml = readFileSync(resolve(root, 'src-tauri', 'Cargo.toml'), 'utf8');
const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];

const versions = {
  'package.json': packageVersion,
  'src-tauri/tauri.conf.json': tauriVersion,
  'src-tauri/Cargo.toml': cargoVersion,
};
const uniqueVersions = new Set(Object.values(versions));

if (uniqueVersions.size !== 1 || uniqueVersions.has(undefined)) {
  console.error('Release manifest versions do not match:');
  for (const [file, version] of Object.entries(versions)) {
    console.error(`  ${file}: ${version ?? 'missing'}`);
  }
  process.exit(1);
}

const version = packageVersion;
const tag = process.argv[2] || process.env.GITHUB_REF_NAME;
if (tag && tag !== `v${version}`) {
  console.error(`Release tag ${tag} does not match manifest version v${version}.`);
  process.exit(1);
}

console.log(`Release version ${version} is consistent${tag ? ` with tag ${tag}` : ''}.`);
