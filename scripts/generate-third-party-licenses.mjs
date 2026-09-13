/**
 * Generate LC's distributable third-party license artifacts.
 *
 * The inventory is a conservative superset of code that can enter a desktop
 * build: installed non-development npm packages plus Cargo's normal runtime
 * dependency closure. Build-only and development-only dependencies are not
 * included. Curated notices cover adapted source and bundled font binaries.
 *
 * Usage:
 *   npm run licenses:generate                    # production package artifacts
 *   node scripts/generate-third-party-licenses.mjs --fonts-only
 *   npm run licenses:check                       # validate without writing artifacts
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(ROOT, 'src-tauri', 'resources', 'THIRD_PARTY_LICENSES.md');
const FONT_OUTPUT = resolve(ROOT, 'public', 'excalidraw-assets', 'LICENSES.md');
const CHECK = process.argv.includes('--check');
const FONTS_ONLY = process.argv.includes('--fonts-only');

const ALLOWED_LICENSES = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSL-1.0',
  'CC0-1.0',
  'CDLA-Permissive-2.0',
  'ISC',
  'LLVM-exception',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'OFL-1.1',
  'Unicode-3.0',
  'Unlicense',
  'Zlib',
]);

const MIT_TEMPLATE = `MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const mitNotice = (copyright) => `MIT License

${copyright}

${MIT_TEMPLATE.slice('MIT License\n\n'.length)}`;

const BSD_3_CLAUSE = `BSD 3-Clause License

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;

const ISC_TEMPLATE = `ISC License

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`;

const ZLIB_TEMPLATE = `zlib License

This software is provided 'as-is', without any express or implied warranty.
In no event will the authors be held liable for any damages arising from the
use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not
   claim that you wrote the original software. If you use this software in a
   product, an acknowledgment in the product documentation would be
   appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.`;

const OFL_1_1 = `SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The fonts,
including any derivative works, can be bundled, embedded, redistributed
and/or sold with any software provided that any reserved names are not used
by derivative works. The fonts and derivatives, however, cannot be released
under any other type of license. The requirement for fonts to remain under
this license does not apply to any document created using the fonts or their
derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may include
source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting, or
substituting -- in part or in whole -- any of the components of the Original
Version, by changing formats or by porting the Font Software to a new
environment.

"Author" refers to any designer, engineer, programmer, technical writer or
other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining a copy
of the Font Software, to use, study, copy, merge, embed, modify, redistribute,
and sell modified and unmodified copies of the Font Software, subject to the
following conditions:

1) Neither the Font Software nor any of its individual components, in
Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy contains
the above copyright notice and this license. These can be included either as
stand-alone text files, human-readable headers or in the appropriate
machine-readable metadata fields within text or binary files as long as those
fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font Name(s)
unless explicit written permission is granted by the corresponding Copyright
Holder. This restriction only applies to the primary font name as presented
to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any Modified
Version, except to acknowledge the contribution(s) of the Copyright Holder(s)
and the Author(s) or with their explicit written permission.

5) The Font Software, modified or unmodified, in part or in whole, must be
distributed entirely under this license, and must not be distributed under
any other license. The requirement for fonts to remain under this license
does not apply to any document created using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF COPYRIGHT, PATENT,
TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE COPYRIGHT HOLDER BE LIABLE
FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, INCLUDING ANY GENERAL, SPECIAL,
INDIRECT, INCIDENTAL, OR CONSEQUENTIAL DAMAGES, WHETHER IN AN ACTION OF
CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF THE USE OR INABILITY TO USE
THE FONT SOFTWARE OR FROM OTHER DEALINGS IN THE FONT SOFTWARE.`;

const CURATED_NOTICES = {
  opencode: mitNotice('Copyright (c) 2025 opencode'),
  excalidraw: mitNotice('Copyright (c) 2020 Excalidraw'),
  mermaid: mitNotice('Copyright (c) 2014 - 2022 Knut Sveidqvist'),
  mermaidToExcalidraw: mitNotice('Copyright (c) 2023 Excalidraw'),
  radix: mitNotice('Copyright (c) 2022 WorkOS'),
  tauri: mitNotice('Copyright (c) 2017 - Present Tauri Apps Contributors'),
  remarkMath: mitNotice('Copyright (c) Junyoung Choi <fluke8259@gmail.com>'),
  removeScrollBar: mitNotice('Copyright (c) 2025 Anton Korzunov <thekashey@gmail.com>'),
  comicShanns: mitNotice(`Copyright (c) 2018 Shannon Miwa
Copyright (c) 2023 Jesus Gonzalez
Copyright (c) 2023 Rodrigo Batista de Moraes
Copyright (c) 2024 Fini Jastrow
Copyright (c) 2024 Kyle Beechly`),
};

const REPOSITORY_NOTICE_OVERRIDES = new Map([
  ['github.com/excalidraw/excalidraw', CURATED_NOTICES.excalidraw],
  ['github.com/radix-ui/primitives', CURATED_NOTICES.radix],
  ['github.com/tauri-apps/tauri', CURATED_NOTICES.tauri],
  ['github.com/remarkjs/remark-math', CURATED_NOTICES.remarkMath],
  ['github.com/thekashey/react-remove-scroll-bar', CURATED_NOTICES.removeScrollBar],
]);

const FONT_ROWS = [
  ['Assistant', 'OFL-1.1', 'Copyright 2020 The Assistant Project Authors; Copyright 2010 The Source Sans Pro Authors; Reserved Font Name Source', 'https://github.com/google/fonts/tree/main/ofl/assistant'],
  ['Cascadia Code', 'OFL-1.1', 'Copyright (c) 2019 - Present, Microsoft Corporation; Reserved Font Name Cascadia Code', 'https://github.com/microsoft/cascadia-code'],
  ['Comic Shanns', 'MIT', 'Copyright holders listed in the Comic Shanns notice below', 'https://github.com/excalidraw/excalidraw/tree/v0.18.1/packages/excalidraw/fonts/ComicShanns'],
  ['Excalifont', 'OFL-1.1', 'Copyright (c) 2024 by Excalidraw', 'https://github.com/excalidraw/excalidraw/tree/v0.18.1/packages/excalidraw/fonts/Excalifont'],
  ['Liberation Sans', 'OFL-1.1', 'Copyright (c) 2010 Google Corporation; Copyright (c) 2012 Red Hat, Inc.; Reserved Font Name Liberation', 'https://github.com/liberationfonts/liberation-fonts'],
  ['Lilita', 'OFL-1.1', 'Copyright (c) 2011 Juan Montoreano; Reserved Font Name Lilita', 'https://github.com/google/fonts/tree/main/ofl/lilitaone'],
  ['Nunito', 'OFL-1.1', 'Copyright 2014 The Nunito Project Authors', 'https://github.com/google/fonts/tree/main/ofl/nunito'],
  ['Virgil', 'OFL-1.1', 'Copyright (c) 2021 - Present, Ellinor Rapp; Reserved Font Name Virgil', 'https://github.com/excalidraw/virgil'],
  ['Xiaolai', 'OFL-1.1', 'Copyright (c) 2020 LXGW', 'https://github.com/excalidraw/excalidraw/tree/v0.18.1/packages/excalidraw/fonts/Xiaolai'],
];

function normalizeText(text) {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
}

function repositoryUrl(repository) {
  const raw = typeof repository === 'string' ? repository : repository?.url;
  if (!raw) return undefined;
  return raw
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git(?:#.*)?$/, '')
    .replace(/\/tree\/[^/]+\/.*$/, '');
}

function repositoryKey(repository) {
  return repositoryUrl(repository)
    ?.replace(/^https?:\/\//, '')
    .toLowerCase();
}

function licenseFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => /^(licen[cs]e|copying|copyright|notice)(?:[-._].*|$)/i.test(name))
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({
      name,
      text: normalizeText(readFileSync(resolve(directory, name), 'utf8')),
    }))
    .filter(({ text }) => text.length > 0);
}

function declaredNpmLicense(packageJson, lockEntry, files) {
  const declared = packageJson.license
    || lockEntry.license
    || packageJson.licenses?.map((item) => item.type).filter(Boolean).join(' OR ');
  if (declared) return declared;
  const body = files.map(({ text }) => text).join('\n');
  if (/permission is hereby granted, free of charge/i.test(body)) return 'MIT';
  if (/mozilla public license/i.test(body)) return 'MPL-2.0';
  if (/apache license[\s\S]{0,80}version 2\.0/i.test(body)) return 'Apache-2.0';
  return undefined;
}

function normalizeExpression(expression) {
  return expression.replace(/\s*\/\s*/g, ' OR ').replace(/\s+/g, ' ').trim();
}

function parseLicenseExpression(expression) {
  const tokens = normalizeExpression(expression).match(/\(|\)|\bAND\b|\bOR\b|\bWITH\b|[A-Za-z0-9][A-Za-z0-9.+-]*/g) || [];
  let cursor = 0;
  const peek = () => tokens[cursor];
  const take = () => tokens[cursor++];

  function atom() {
    if (peek() === '(') {
      take();
      const value = or();
      if (take() !== ')') throw new Error(`Unbalanced license expression: ${expression}`);
      return value;
    }
    const id = take();
    if (!id || ['AND', 'OR', 'WITH', ')'].includes(id)) {
      throw new Error(`Invalid license expression: ${expression}`);
    }
    return { type: 'id', id };
  }

  function withException() {
    let value = atom();
    if (peek() === 'WITH') {
      take();
      value = { type: 'and', left: value, right: { type: 'id', id: take() } };
    }
    return value;
  }

  function and() {
    let value = withException();
    while (peek() === 'AND') {
      take();
      value = { type: 'and', left: value, right: withException() };
    }
    return value;
  }

  function or() {
    let value = and();
    while (peek() === 'OR') {
      take();
      value = { type: 'or', left: value, right: and() };
    }
    return value;
  }

  const result = or();
  if (cursor !== tokens.length) throw new Error(`Unsupported license expression: ${expression}`);
  return result;
}

const LICENSE_PRIORITY = new Map([
  ['MIT', 1],
  ['Apache-2.0', 2],
  ['ISC', 3],
  ['BSD-2-Clause', 4],
  ['BSD-3-Clause', 5],
  ['Zlib', 6],
  ['0BSD', 7],
  ['MPL-2.0', 20],
  ['Unicode-3.0', 21],
]);

function satisfyingLicenses(node) {
  if (node.type === 'id') return ALLOWED_LICENSES.has(node.id) ? [node.id] : undefined;
  const left = satisfyingLicenses(node.left);
  const right = satisfyingLicenses(node.right);
  if (node.type === 'and') return left && right ? [...new Set([...left, ...right])] : undefined;
  if (!left) return right;
  if (!right) return left;
  const score = (ids) => ids.reduce((sum, id) => sum + (LICENSE_PRIORITY.get(id) || 50), 0);
  return score(left) <= score(right) ? left : right;
}

function chosenLicenses(expression) {
  return satisfyingLicenses(parseLicenseExpression(expression));
}

function assertAllowed(item) {
  let chosen;
  try {
    chosen = chosenLicenses(item.license);
  } catch (error) {
    throw new Error(`${item.ecosystem} ${item.name}@${item.version}: ${error.message}`);
  }
  if (!chosen) {
    throw new Error(`${item.ecosystem} ${item.name}@${item.version} has no approved license path: ${item.license}`);
  }
  item.chosen = chosen;
}

function collectNpm() {
  if (!existsSync(resolve(ROOT, 'node_modules'))) {
    throw new Error('node_modules is missing; install dependencies before generating release licenses');
  }
  const lock = JSON.parse(readFileSync(resolve(ROOT, 'package-lock.json'), 'utf8'));
  const packages = [];
  // The same package@version is often installed at several nested locations in
  // node_modules (npm pins a copy under each parent that needs it), so a single
  // lockfile package appears once per location. Each location is a separate
  // lock entry, so without deduplication the manifest lists one row per copy.
  // Deduplicate by name@version: keep the first location's item, and only
  // upgrade its license files if a later copy ships files while the kept one
  // does not (the license declaration itself was already validated above).
  const seen = new Map();
  for (const [location, lockEntry] of Object.entries(lock.packages || {})) {
    if (!location || lockEntry.dev === true) continue;
    const directory = resolve(ROOT, location);
    // Platform-specific optional packages that npm did not install cannot enter
    // the current frontend bundle and are intentionally excluded.
    if (!existsSync(directory)) continue;
    const packageJson = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
    const files = licenseFiles(directory);
    const license = declaredNpmLicense(packageJson, lockEntry, files);
    if (!license) throw new Error(`npm ${packageJson.name}@${packageJson.version} has no declared or discoverable license`);
    const item = {
      ecosystem: 'npm',
      name: packageJson.name,
      version: packageJson.version,
      license: normalizeExpression(license),
      authors: [packageJson.author, ...(packageJson.contributors || [])].filter(Boolean).map(String),
      repository: repositoryUrl(packageJson.repository),
      source: repositoryUrl(packageJson.repository) || `https://www.npmjs.com/package/${packageJson.name}/v/${packageJson.version}`,
      files,
    };
    assertAllowed(item);
    const key = `${item.name}@${item.version}`;
    const existing = seen.get(key);
    if (existing) {
      if (item.files.length > 0 && existing.files.length === 0) existing.files = item.files;
      continue;
    }
    seen.set(key, item);
    packages.push(item);
  }
  return packages;
}

function collectCargo() {
  const metadata = JSON.parse(execFileSync('cargo', [
    'metadata',
    '--locked',
    '--format-version', '1',
    '--manifest-path', resolve(ROOT, 'src-tauri', 'Cargo.toml'),
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  const rootId = metadata.resolve.root;
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const runtimeIds = new Set([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const node = nodes.get(queue.shift());
    for (const dependency of node?.deps || []) {
      const isRuntime = dependency.dep_kinds.some(({ kind }) => kind === null);
      if (isRuntime && !runtimeIds.has(dependency.pkg)) {
        runtimeIds.add(dependency.pkg);
        queue.push(dependency.pkg);
      }
    }
  }

  const packages = [];
  for (const packageInfo of metadata.packages) {
    if (packageInfo.id === rootId || !runtimeIds.has(packageInfo.id)) continue;
    if (!packageInfo.license) throw new Error(`Cargo ${packageInfo.name}@${packageInfo.version} has no declared license`);
    const item = {
      ecosystem: 'Cargo',
      name: packageInfo.name,
      version: packageInfo.version,
      license: normalizeExpression(packageInfo.license),
      authors: packageInfo.authors || [],
      repository: repositoryUrl(packageInfo.repository),
      source: repositoryUrl(packageInfo.repository) || `https://crates.io/crates/${packageInfo.name}/${packageInfo.version}`,
      files: licenseFiles(dirname(packageInfo.manifest_path)),
    };
    assertAllowed(item);
    packages.push(item);
  }
  return packages;
}

/**
 * The license texts one package contributes, each as a separately addressable
 * part. Returning parts rather than one concatenated blob is what lets an
 * identical text shared by many packages be reproduced once; see
 * `renderInventory`.
 *
 * `bundled: false` marks a package that shipped no license file of its own, so
 * the standard text for its selected license is used instead.
 */
function noticeParts(item, references) {
  const repositoryOverride = REPOSITORY_NOTICE_OVERRIDES.get(repositoryKey(item.repository));
  if (repositoryOverride) return { parts: [{ name: 'NOTICE', text: repositoryOverride }], bundled: true };
  if (item.files.length > 0) return { parts: item.files, bundled: true };

  const parts = item.chosen.map((id) => {
    const text = references.get(id);
    if (!text) throw new Error(`No fallback text available for ${id} (${item.ecosystem} ${item.name}@${item.version})`);
    return { name: id, text };
  });
  return { parts, bundled: false };
}

const itemKey = (item) => `${item.ecosystem}:${item.name}@${item.version}`;
const itemLabel = (item) => `${item.ecosystem} ${item.name}@${item.version}`;
const inlineCode = (value) => `\`${String(value).replace(/`/g, 'ˋ')}\``;

// --- Standard license consolidation ----------------------------------------

const APACHE_END_MARKER = 'END OF TERMS AND CONDITIONS';
const MIT_GRANT_MARKER = 'Permission is hereby granted, free of charge';
const ISC_GRANT_MARKER = 'Permission to use, copy, modify, and/or distribute';
const ZLIB_WARRANTY_MARKER = "This software is provided 'as-is'";
const BSD_GRANT_MARKER = 'Redistribution and use in source and binary forms';
// A copyright preamble longer than this is not a plain copyright statement;
// the whole text is kept verbatim instead of guessing where the notice ends.
const MAX_COPYRIGHT_PREAMBLE = 600;

const squashText = (text) => text.replace(/\s+/g, ' ').trim();
const foldQuotes = (text) => text.replace(/[\u0027\u2018\u2019\u201C\u201D*]/g, '"');
// Shipped copies of the standard bodies differ only in whitespace, quote
// style ('Software' vs "Software" vs *AS IS*), and a dropped final period.
const bodyKeyOf = (text) => squashText(foldQuotes(text)).replace(/\.$/, '');

const MIT_BODY_KEY = bodyKeyOf(MIT_TEMPLATE.slice('MIT License\n\n'.length));
const ISC_BODY_KEY = bodyKeyOf(ISC_TEMPLATE.slice('ISC License\n\n'.length));
const ZLIB_BODY_KEY = bodyKeyOf(ZLIB_TEMPLATE.slice('zlib License\n\n'.length));
const BSD_3_BODY_KEY = bodyKeyOf(BSD_3_CLAUSE.slice('BSD 3-Clause License\n\n'.length));

const COPYRIGHT_LINE = /^(copyright|\(c\)|©|all rights reserved|based on)/i;
const LICENSE_TITLE_LINES = [
  /^\(?\s*(the\s+)?mit\s+license\s*(\(mit\))?\s*\)?$/i,
  /^\(?\s*(the\s+)?isc\s+license\s*(\(isc\))?\s*\)?$/i,
  /^zlib\s+license$/i,
  /^bsd\s+3-clause\s+license$/i,
];

function extractCopyrightNotices(preamble) {
  if (preamble.length > MAX_COPYRIGHT_PREAMBLE) return undefined;
  const lines = preamble.split('\n').map((line) => line.trim()).filter(Boolean);
  // Markdown title underlines ("The MIT License (MIT)\n=====") carry nothing.
  const notices = lines.filter((line) => !/^[=-]+$/.test(line)
    && !LICENSE_TITLE_LINES.some((title) => title.test(line)));
  if (notices.length === 0) return '';
  if (!notices.every((line) => COPYRIGHT_LINE.test(line))) return undefined;
  return notices.join('; ');
}

function matchGrantBody(text, marker, bodyKey) {
  const index = text.indexOf(marker);
  if (index === -1 || index > MAX_COPYRIGHT_PREAMBLE) return undefined;
  if (bodyKeyOf(text.slice(index)) !== bodyKey) return undefined;
  return extractCopyrightNotices(text.slice(0, index));
}

function matchApache(text, apacheCoreKey) {
  const index = text.indexOf(APACHE_END_MARKER);
  if (index === -1) return undefined;
  // Shipped copies sometimes modernize the canonical header URL; treat the
  // variants as the same text.
  const core = text.slice(0, index + APACHE_END_MARKER.length)
    .replace(/https?:\/\/www\.apache\.org\/licenses(?:\/LICENSE-2\.0)?\/+/g, 'http://www.apache.org/licenses/');
  if (squashText(core) !== apacheCoreKey) return undefined;
  const appendix = text.slice(index + APACHE_END_MARKER.length).trim();
  const foldableAppendix = appendix === ''
    || (/^APPENDIX/i.test(appendix) && appendix.length <= 1250)
    || (/^(Copyright|Licensed under)/i.test(appendix) && appendix.length <= 600
      && /Licensed under the Apache License, Version 2\.0/.test(appendix)
      && !/llvm/i.test(appendix));
  if (!foldableAppendix) return undefined;
  return appendix.split('\n')
    .map((line) => line.trim())
    .filter((line) => /^copyright/i.test(line) && !/yyyy|name of copyright owner/i.test(line))
    .join('; ');
}

const FAMILY_TITLES = new Map([
  ['MIT', 'MIT License'],
  ['Apache-2.0', 'Apache License, Version 2.0'],
  ['MPL-2.0', 'Mozilla Public License Version 2.0'],
  ['ISC', 'ISC License'],
  ['Zlib', 'zlib License'],
  ['BSD-3-Clause', 'BSD 3-Clause License'],
]);

// Maps a chosen license id to the consolidated family whose terms that
// selection relies on; other ids map to themselves.
function familyOfChosenId(id) {
  if (id === 'LLVM-exception') return 'Apache-2.0';
  return id;
}

// The license branches a file's name attributes it to, when the name names
// any. Generically named files (LICENSE, COPYING, COPYRIGHT, NOTICE, *.spdx)
// match no branch and are always reproduced.
function branchesOfFilename(name) {
  const n = name.toLowerCase();
  const branches = new Set();
  if (/apache|llvm/.test(n)) branches.add('Apache-2.0');
  if (/(^|[^a-z0-9])mit([^a-z0-9]|$)/.test(n)) branches.add('MIT');
  if (/(^|[^a-z0-9])isc([^a-z0-9]|$)/.test(n)) branches.add('ISC');
  if (/(^|[^a-z0-9])mpl([^a-z0-9]|$)/.test(n)) branches.add('MPL-2.0');
  if (/(^|[^a-z0-9])zlib([^a-z0-9]|$)/.test(n)) branches.add('Zlib');
  if (/bsd-?3/.test(n)) branches.add('BSD-3-Clause');
  if (/bsd-?2/.test(n)) branches.add('BSD-2-Clause');
  return branches;
}

// A short file that merely lists the licenses a package offers — a pointer
// such as "Licensed under the Apache License, Version 2.0 <LICENSE-APACHE or
// http://...>" — carries no copyright notice and never needs to be
// reproduced. Such a pointer is dropped when it mentions a branch LC did not
// select; the selected branch's terms and copyright notices are carried in
// the consolidated blocks. Pointers mentioning only selected branches stay.
function barePointerToUnselectedBranch(text, chosenFamilies) {
  if (text.length > 800 || !/licen[cs]e/i.test(text)) return false;
  if (text.split('\n').some((line) => /^(copyright|©|\(c\))/i.test(line.trim()))) return false;
  const mentioned = new Set();
  if (/apache/i.test(text)) mentioned.add('Apache-2.0');
  if (/(^|[^a-z])mit([^a-z]|$)/i.test(text)) mentioned.add('MIT');
  if (/(^|[^a-z])isc([^a-z]|$)/i.test(text)) mentioned.add('ISC');
  if (/mozilla|(^|[^a-z])mpl([^a-z]|$)/i.test(text)) mentioned.add('MPL-2.0');
  if (mentioned.size === 0) return false;
  return [...mentioned].some((branch) => !chosenFamilies.has(branch));
}

/**
 * Returns `{ family, copyright }` when `text` is the standard body of one of
 * the consolidated licenses — optionally preceded by a short copyright
 * preamble — and undefined otherwise. Undefined texts are reproduced
 * verbatim by `renderInventory`.
 */
function classifyStandardPart(text, apacheCoreKey, mplKey) {
  const mit = matchGrantBody(text, MIT_GRANT_MARKER, MIT_BODY_KEY);
  if (mit !== undefined) return { family: 'MIT', copyright: mit };
  const isc = matchGrantBody(text, ISC_GRANT_MARKER, ISC_BODY_KEY);
  if (isc !== undefined) return { family: 'ISC', copyright: isc };
  const zlib = matchGrantBody(text, ZLIB_WARRANTY_MARKER, ZLIB_BODY_KEY);
  if (zlib !== undefined) return { family: 'Zlib', copyright: zlib };
  const bsd = matchGrantBody(text, BSD_GRANT_MARKER, BSD_3_BODY_KEY);
  if (bsd !== undefined) return { family: 'BSD-3-Clause', copyright: bsd };
  const apache = matchApache(text, apacheCoreKey);
  if (apache !== undefined) return { family: 'Apache-2.0', copyright: apache };
  if (mplKey && squashText(text) === mplKey) return { family: 'MPL-2.0', copyright: '' };
  return undefined;
}

function apacheReferenceText() {
  const text = normalizeText(readFileSync(resolve(ROOT, 'LICENSE'), 'utf8'));
  const index = text.indexOf(APACHE_END_MARKER);
  // Consolidated output carries the license terms themselves; the "how to
  // apply" appendix of LC's own LICENSE is not part of the Apache-2.0 text
  // recipients need a copy of.
  return index === -1 ? text : text.slice(0, index + APACHE_END_MARKER.length);
}

function chooseMplReference(items) {
  const counts = new Map();
  for (const item of items) {
    for (const { text } of item.files) {
      if (!/mozilla public license[\s\S]{0,200}version 2\.0/i.test(text)) continue;
      const key = squashText(text);
      const entry = counts.get(key) || { count: 0, text };
      entry.count += 1;
      counts.set(key, entry);
    }
  }
  const best = [...counts.values()]
    .sort((left, right) => right.count - left.count || left.text.localeCompare(right.text))[0];
  return best?.text;
}

function buildReferences(items) {
  const mplReference = chooseMplReference(items);
  const references = new Map([
    ['MIT', MIT_TEMPLATE],
    ['Apache-2.0', apacheReferenceText()],
    ['BSD-3-Clause', BSD_3_CLAUSE],
    ['ISC', ISC_TEMPLATE],
    ['Zlib', ZLIB_TEMPLATE],
    ['OFL-1.1', OFL_1_1],
  ]);
  if (mplReference) references.set('MPL-2.0', mplReference);
  const signatures = new Map([
    ['Unicode-3.0', /unicode license v3/i],
    ['0BSD', /zero-clause bsd/i],
    ['CC0-1.0', /cc0 1\.0 universal/i],
    ['CDLA-Permissive-2.0', /community data license agreement[\s\S]*permissive/i],
    ['BSL-1.0', /boost software license[\s\S]*version 1\.0/i],
    ['MIT-0', /mit no attribution/i],
    ['Unlicense', /this is free and unencumbered software released into the public domain/i],
    ['LLVM-exception', /llvm exception/i],
    ['BSD-2-Clause', /redistribution and use in source and binary forms[\s\S]*two conditions/i],
  ]);
  for (const item of items) {
    for (const { text } of item.files) {
      for (const [id, signature] of signatures) {
        if (!references.has(id) && signature.test(text)) references.set(id, text);
      }
    }
  }
  return references;
}

function markdownLink(label, url) {
  return url ? `[${label}](${url})` : label;
}

function renderFontRows() {
  return FONT_ROWS.map(([name, license, copyright, source]) =>
    `| ${markdownLink(name, source)} | ${license} | ${copyright} |`).join('\n');
}

function renderFontManifest() {
  return `# Excalidraw font licenses

LC copies these font binaries from \`@excalidraw/excalidraw\` 0.18.1 during
the production build. The fonts remain under their respective licenses and
are not relicensed under LC's Apache-2.0 license.

| Font | License | Copyright and reserved-name information |
| --- | --- | --- |
${renderFontRows()}

## Comic Shanns MIT notice

\`\`\`text
${CURATED_NOTICES.comicShanns}
\`\`\`

## SIL Open Font License 1.1

\`\`\`text
${OFL_1_1}
\`\`\`
`;
}

function renderInventory(items, references) {
  // A license file that is exactly one of the standard permissive license
  // texts — optionally preceded by a copyright preamble — is consolidated
  // into a single block per license: the text is reproduced once, every
  // package it applies to is listed, and each package's copyright notice is
  // carried alongside it, which is what MIT, ISC, BSD-3-Clause, and Zlib
  // require to be reproduced with the license text. Everything else keeps
  // the previous behavior: an identical text shared by many packages is
  // reproduced once and attributed to all of them; a unique text is
  // reproduced in full on its own. Where a package offers alternative
  // licenses, only the files of the branch LC selected (the "Selected"
  // column) are reproduced.
  const families = [...FAMILY_TITLES.keys()].map((id) => ({
    id,
    text: references.get(id),
    items: [],
    copyrights: new Map(),
  }));
  const familyById = new Map(families.map((family) => [family.id, family]));
  const apacheCoreKey = squashText(references.get('Apache-2.0'));
  const mplKey = references.has('MPL-2.0') ? squashText(references.get('MPL-2.0')) : undefined;

  const texts = new Map();
  const refsByItem = new Map();
  const unbundled = [];

  for (const item of items) {
    const { parts, bundled } = noticeParts(item, references);
    if (!bundled) unbundled.push(item);
    const chosenFamilies = new Set(item.chosen.map(familyOfChosenId));
    const classified = parts.map((part) => ({ part, match: classifyStandardPart(part.text, apacheCoreKey, mplKey) }));
    // Where a package offers alternative licenses, reproduce only the files
    // of the branch LC selected: the other branches' terms do not govern
    // LC's use. Files that fit no branch — custom notices, NOTICE, SPDX, and
    // COPYRIGHT files — are always kept, and a package is never pruned down
    // to nothing.
    const applicable = classified.filter(({ part, match }) => {
      if (/^notice/i.test(part.name)) return true;
      if (match) return chosenFamilies.has(match.family);
      const branches = branchesOfFilename(part.name);
      if (branches.size > 0) return [...branches].some((branch) => chosenFamilies.has(branch));
      return !barePointerToUnselectedBranch(part.text, chosenFamilies);
    });
    const kept = applicable.length > 0 ? applicable : classified;
    const refs = [];
    for (const { part: { name, text }, match } of kept) {
      if (match) {
        const family = familyById.get(match.family);
        if (family.items[family.items.length - 1] !== item) family.items.push(item);
        if (match.copyright) {
          const notices = family.copyrights.get(item) || new Set();
          notices.add(match.copyright);
          family.copyrights.set(item, notices);
        }
        refs.push(`family:${match.family}`);
      } else {
        const hash = createHash('sha256').update(text).digest('hex');
        let entry = texts.get(hash);
        if (!entry) {
          entry = { text, names: new Set(), items: [] };
          texts.set(hash, entry);
        }
        entry.names.add(name);
        // Items are processed one at a time, so the last entry is the only
        // possible duplicate (a package shipping the same text under two names).
        if (entry.items[entry.items.length - 1] !== item) entry.items.push(item);
        refs.push(hash);
      }
    }
    refsByItem.set(item, [...new Set(refs)]);
  }

  const usedFamilies = families.filter((family) => family.items.length > 0);
  const groups = [...texts.entries()]
    .map(([hash, entry]) => ({ hash, ...entry, sortKey: entry.items.map(itemKey).sort()[0] }))
    .sort((left, right) => left.sortKey.localeCompare(right.sortKey) || left.hash.localeCompare(right.hash))
    .map((group, index) => ({ ...group, id: `L${String(usedFamilies.length + index + 1).padStart(3, '0')}` }));

  const idByRef = new Map(groups.map((group) => [group.hash, group.id]));
  usedFamilies.forEach((family, index) => idByRef.set(`family:${family.id}`, `L${String(index + 1).padStart(3, '0')}`));

  const sorted = [...items].sort((left, right) => itemKey(left).localeCompare(itemKey(right)));
  const rows = sorted.map((item) => {
    const notice = refsByItem.get(item)
      .map((ref) => idByRef.get(ref))
      .sort()
      .map((id) => `[${id}](#${id.toLowerCase()})`)
      .join(', ');
    return `| ${item.ecosystem} | ${markdownLink(`${item.name} ${item.version}`, item.source)} | ${item.license} | ${item.chosen.join(' AND ')} | ${notice} |`;
  });

  const familyNotices = usedFamilies.map((family, index) => {
    const id = `L${String(index + 1).padStart(3, '0')}`;
    const applies = family.items.map(itemLabel).sort().join(', ');
    const noticeRows = [...family.copyrights.entries()]
      .sort(([left], [right]) => itemKey(left).localeCompare(itemKey(right)))
      .map(([item, notices]) => `- ${itemLabel(item)} — ${[...notices].join('; ')}`);
    const copyrightSection = noticeRows.length === 0
      ? ''
      : `\nCopyright notices:\n\n${noticeRows.join('\n')}\n`;
    return `<a id="${id.toLowerCase()}"></a>\n\n### ${id} — ${FAMILY_TITLES.get(family.id)} (standard text)\n\nApplies to: ${applies}\n${copyrightSection}\n\`\`\`text\n${family.text}\n\`\`\``;
  });

  const notices = groups.map((group) => {
    const names = [...group.names].sort().join(', ');
    const applies = group.items.map(itemLabel).sort().join(', ');
    return `<a id="${group.id.toLowerCase()}"></a>\n\n### ${group.id} — ${names}\n\nApplies to: ${applies}\n\n\`\`\`text\n${group.text}\n\`\`\``;
  });

  const unbundledSection = unbundled.length === 0 ? '' : `

### Packages without a bundled license file

These published packages contained no standalone license file. The standard
text of the license each one declares appears in the consolidated block its
Notice link above points to.

${unbundled
    .sort((left, right) => itemKey(left).localeCompare(itemKey(right)))
    .map((item) => {
      const authors = item.authors.length
        ? `; authors: ${item.authors.map(inlineCode).join(', ')}`
        : '';
      return `- **${itemLabel(item)}** — declares ${inlineCode(item.license)}${authors}`;
    })
    .join('\n')}`;

  return `## Production dependency inventory

This inventory is generated from installed non-development npm packages and
the Cargo normal-runtime dependency closure. A platform-specific installer may
contain a subset of this conservative inventory. "Selected" records the
permissive branch LC relies on where a package offers alternative licenses.

| Ecosystem | Package | Declared license | Selected | Notice |
| --- | --- | --- | --- | --- |
${rows.join('\n')}
${unbundledSection}

## Dependency license texts

Where a package's license file matches the standard text of a common
permissive license, it is consolidated into one block per license: the
standard text is reproduced once, followed by every package it applies to
and each package's copyright notice — the notice those licenses require to
be reproduced with the license text. Where a package offers alternative
licenses, only the files of the branch recorded in the Selected column are
reproduced. Texts that do not match a standard license body — custom
notices, NOTICE files, SPDX records, license exceptions, combined and
dual-license statements — are reproduced verbatim, in full, as their own
entries, and an identical text shared by many packages is reproduced once
and attributed to all of them.

${[...familyNotices, ...notices].join('\n\n')}`;
}

function renderManifest(npmPackages, cargoPackages) {
  const allPackages = [...npmPackages, ...cargoPackages];
  const references = buildReferences(allPackages);
  return `# Third-party licenses

LC is licensed under Apache-2.0. The components and assets listed here remain
under their respective licenses. This file is generated by
\`scripts/generate-third-party-licenses.mjs\`; do not edit it manually.

## Adapted source: OpenCode apply patch

Portions of LC's patch parsing and contextual matching algorithm were adapted
from [OpenCode](https://github.com/anomalyco/opencode), whose cloned source was
audited at v1.18.3. LC's additional implementation is licensed under
Apache-2.0; the adapted OpenCode portions carry this MIT notice:

\`\`\`text
${CURATED_NOTICES.opencode}
\`\`\`

## Embedded libraries highlighted by LC

### Excalidraw 0.18.1

Source: https://github.com/excalidraw/excalidraw/tree/v0.18.1

\`\`\`text
${CURATED_NOTICES.excalidraw}
\`\`\`

### Mermaid 11.16.0

Source: https://github.com/mermaid-js/mermaid/tree/v11.16.0

\`\`\`text
${CURATED_NOTICES.mermaid}
\`\`\`

### Mermaid to Excalidraw 2.2.2

Source: https://github.com/excalidraw/mermaid-to-excalidraw

\`\`\`text
${CURATED_NOTICES.mermaidToExcalidraw}
\`\`\`

## Fonts bundled with Excalidraw

The font binaries below are copied from \`@excalidraw/excalidraw\` during the
LC build. They remain under their own licenses and are not relicensed under
Apache-2.0.

| Font | License | Copyright and reserved-name information |
| --- | --- | --- |
${renderFontRows()}

### Comic Shanns MIT notice

\`\`\`text
${CURATED_NOTICES.comicShanns}
\`\`\`

### SIL Open Font License 1.1

\`\`\`text
${OFL_1_1}
\`\`\`

${renderInventory(allPackages, references)}
`;
}

try {
  const generatedFonts = renderFontManifest();
  if (FONTS_ONLY) {
    mkdirSync(dirname(FONT_OUTPUT), { recursive: true });
    writeFileSync(FONT_OUTPUT, generatedFonts, 'utf8');
    console.log('✓ generated Excalidraw font license artifact');
  } else {
    const npmPackages = collectNpm();
    const cargoPackages = collectCargo();
    const generated = renderManifest(npmPackages, cargoPackages);
    if (CHECK) {
      for (const snippet of [
        'Copyright (c) 2025 opencode',
        '## Production dependency inventory',
        '## Dependency license texts',
        'SIL OPEN FONT LICENSE Version 1.1',
      ]) {
        if (!generated.includes(snippet)) throw new Error(`generated release manifest is missing: ${snippet}`);
      }
      console.log(`✓ release license inventory validated (${npmPackages.length} npm packages, ${cargoPackages.length} Cargo packages; no artifacts written)`);
    } else {
      mkdirSync(dirname(OUTPUT), { recursive: true });
      mkdirSync(dirname(FONT_OUTPUT), { recursive: true });
      writeFileSync(OUTPUT, generated, 'utf8');
      writeFileSync(FONT_OUTPUT, generatedFonts, 'utf8');
      console.log(`✓ generated production license artifacts (${npmPackages.length} npm packages, ${cargoPackages.length} Cargo packages)`);
    }
  }
} catch (error) {
  console.error(`License generation failed: ${error.message}`);
  process.exit(1);
}
