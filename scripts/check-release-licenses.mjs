/**
 * Verify LC's source metadata and generated release resources.
 *
 * `--frontend-artifacts` checks the ordinary Vite output and common Tauri
 * resources. `--artifacts` additionally requires the production-only
 * dependency inventory used by packaged desktop distributions.
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_RELEASE_ARTIFACTS = process.argv.includes('--artifacts');
const CHECK_FRONTEND_ARTIFACTS = CHECK_RELEASE_ARTIFACTS || process.argv.includes('--frontend-artifacts');
const failures = [];

const requireFile = (path, label = path) => {
  const absolute = resolve(ROOT, path);
  if (!existsSync(absolute)) {
    failures.push(`${label} is missing: ${absolute}`);
    return undefined;
  }
  return absolute;
};

const requireText = (path, snippets) => {
  const absolute = requireFile(path);
  if (!absolute) return;
  const text = readFileSync(absolute, 'utf8');
  for (const snippet of snippets) {
    if (!text.includes(snippet)) failures.push(`${path} does not contain required text: ${snippet}`);
  }
};

const packageJsonPath = requireFile('package.json');
if (packageJsonPath) {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  if (packageJson.license !== 'Apache-2.0') failures.push('package.json license must be Apache-2.0');
}

const packageLockPath = requireFile('package-lock.json');
if (packageLockPath) {
  const packageLock = JSON.parse(readFileSync(packageLockPath, 'utf8'));
  if (packageLock.packages?.['']?.license !== 'Apache-2.0') {
    failures.push('package-lock.json root package license must be Apache-2.0');
  }
}

requireText('src-tauri/Cargo.toml', ['license = "Apache-2.0"']);
requireText('src-tauri/src/tools/apply_patch.rs', [
  'adapted from OpenCode',
  'Copyright (c) 2025 opencode',
  'licensed under MIT',
]);
const tauriConfigPath = requireFile('src-tauri/tauri.conf.json');
if (tauriConfigPath) {
  const config = JSON.parse(readFileSync(tauriConfigPath, 'utf8'));
  if (config.bundle?.license !== 'Apache-2.0') failures.push('Tauri bundle.license must be Apache-2.0');
  if (config.bundle?.licenseFile !== '../LICENSE') failures.push('Tauri bundle.licenseFile must point to ../LICENSE');
  if (config.bundle?.active !== false) failures.push('Default Tauri bundle.active must be false; use the release config to package distributions');
  const resources = new Set(config.bundle?.resources || []);
  for (const resource of ['resources/LICENSE', 'resources/NOTICE']) {
    if (!resources.has(resource)) failures.push(`Tauri bundle.resources is missing ${resource}`);
  }
  if (resources.has('resources/THIRD_PARTY_LICENSES.md')) {
    failures.push('Default Tauri config must not require the production-only dependency inventory');
  }
}

const releaseConfigPath = requireFile('src-tauri/tauri.release.conf.json');
if (releaseConfigPath) {
  const config = JSON.parse(readFileSync(releaseConfigPath, 'utf8'));
  if (config.bundle?.active !== true) failures.push('Release Tauri bundle.active must be true');
  const resources = new Set(config.bundle?.resources || []);
  for (const resource of [
    'resources/LICENSE',
    'resources/NOTICE',
    'resources/THIRD_PARTY_LICENSES.md',
  ]) {
    if (!resources.has(resource)) failures.push(`Tauri release bundle.resources is missing ${resource}`);
  }
}

if (CHECK_FRONTEND_ARTIFACTS) {
  const publicManifest = requireFile('public/excalidraw-assets/LICENSES.md');
  const distManifest = requireFile('dist/excalidraw-assets/LICENSES.md');
  for (const manifest of [publicManifest, distManifest]) {
    if (!manifest) continue;
    const text = readFileSync(manifest, 'utf8');
    for (const snippet of ['SIL OPEN FONT LICENSE Version 1.1', 'Comic Shanns MIT notice']) {
      if (!text.includes(snippet)) failures.push(`${manifest} does not contain required text: ${snippet}`);
    }
  }
  const stagedLegalFiles = ['LICENSE', 'NOTICE'];
  for (const filename of stagedLegalFiles) {
    const source = requireFile(filename);
    const staged = requireFile(`src-tauri/resources/${filename}`);
    if (source && staged && !readFileSync(source).equals(readFileSync(staged))) {
      failures.push(`src-tauri/resources/${filename} differs from ${filename}`);
    }
  }
  if (publicManifest && distManifest && !readFileSync(publicManifest).equals(readFileSync(distManifest))) {
    failures.push('dist Excalidraw font license artifact differs from the generated public artifact');
  }

  const fontRoot = resolve(ROOT, 'dist', 'excalidraw-assets', 'fonts');
  const expectedFonts = ['Assistant', 'Cascadia', 'ComicShanns', 'Excalifont', 'Liberation', 'Lilita', 'Nunito', 'Virgil', 'Xiaolai'];
  if (!existsSync(fontRoot)) {
    failures.push(`built Excalidraw font directory is missing: ${fontRoot}`);
  } else {
    const actualFonts = new Set(readdirSync(fontRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name));
    for (const font of expectedFonts) if (!actualFonts.has(font)) failures.push(`built Excalidraw fonts are missing ${font}`);
  }
}

if (CHECK_RELEASE_ARTIFACTS) {
  requireText('src-tauri/resources/THIRD_PARTY_LICENSES.md', [
    'Copyright (c) 2025 opencode',
    '### Excalidraw 0.18.1',
    '### Mermaid 11.16.0',
    '### Mermaid to Excalidraw 2.2.2',
    'SIL OPEN FONT LICENSE Version 1.1',
    'Assistant',
    'Cascadia Code',
    'Comic Shanns',
    'Excalifont',
    'Liberation Sans',
    'Lilita',
    'Nunito',
    'Virgil',
    'Xiaolai',
    '## Production dependency inventory',
    '## Dependency license texts',
  ]);
}

if (failures.length > 0) {
  console.error('Release license audit failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

const scope = CHECK_RELEASE_ARTIFACTS
  ? ' (including production package artifacts)'
  : CHECK_FRONTEND_ARTIFACTS
    ? ' (including frontend artifacts)'
    : '';
console.log(`✓ release license audit passed${scope}`);
