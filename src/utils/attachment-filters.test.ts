/**
 * Attachment allowlist — the extensionless-name exceptions.
 *
 * Every other rule in `isAllowedAttachment` keys off an extension or a
 * MIME type. `LICENSE` and friends have neither, so they used to be
 * rejected as if they were binaries. These tests pin the exception list
 * and, just as importantly, pin what it must NOT swallow: the guardrail
 * still has to keep real binaries out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowedAttachment,
  isKnownExtensionlessTextName,
  langFromName,
} from './attachments.ts';

/** Extensionless files arrive with no MIME — that is the whole problem. */
function bare(name: string): File {
  return new File(['body'], name, { type: '' });
}

test('accepts conventional extensionless text files', () => {
  for (const name of [
    'LICENSE', 'LICENCE', 'NOTICE', 'COPYING', 'COPYRIGHT',
    'README', 'CHANGELOG', 'AUTHORS', 'CONTRIBUTORS', 'CODEOWNERS',
    'TODO', 'VERSION', 'INSTALL', 'NEWS', 'SECURITY', 'MANIFEST',
    'Makefile', 'GNUmakefile', 'Dockerfile', 'Containerfile',
    'Gemfile', 'Rakefile', 'Brewfile', 'Procfile', 'Justfile',
    'Vagrantfile', 'Jenkinsfile',
  ]) {
    assert.equal(isAllowedAttachment(bare(name)), true, `${name} should be accepted`);
  }
});

test('name matching is case-insensitive', () => {
  for (const name of ['license', 'License', 'LICENSE', 'lIcEnSe']) {
    assert.equal(isKnownExtensionlessTextName(name), true, name);
  }
  assert.equal(isKnownExtensionlessTextName('MAKEFILE'), true);
});

test('accepts the license family with a variant qualifier', () => {
  for (const name of [
    'LICENSE-MIT', 'LICENSE-APACHE', 'LICENSE.APACHE-2.0',
    'COPYING.LESSER', 'NOTICE-third-party', 'copyright_2026',
  ]) {
    assert.equal(isAllowedAttachment(bare(name)), true, `${name} should be accepted`);
  }
});

test('accepts common extensionless dotfiles', () => {
  for (const name of [
    '.gitignore', '.gitattributes', '.gitmodules', '.dockerignore',
    '.editorconfig', '.npmrc', '.nvmrc', '.npmignore',
    '.babelrc', '.prettierrc', '.eslintrc',
  ]) {
    assert.equal(isAllowedAttachment(bare(name)), true, `${name} should be accepted`);
  }
});

test('still rejects binaries and unknown bare names', () => {
  for (const name of [
    'thing.exe', 'movie.mp4', 'archive.zip', 'font.woff2', 'photo.psd',
    // A bare name that is not a known convention stays rejected — the
    // exception list is an allowlist, not "anything without a dot".
    'somefile', 'data', 'a.out',
  ]) {
    assert.equal(isAllowedAttachment(bare(name)), false, `${name} should be rejected`);
  }
});

test('a binary extension vetoes the name rules', () => {
  // The name says "license", the extension says "executable". The
  // extension wins — otherwise the family pattern hands a binary to the
  // UTF-8 decoder.
  for (const name of [
    'LICENSE.exe', 'LICENSE.dll', 'NOTICE.zip', 'COPYING.tar.gz',
    'license.msi', 'COPYRIGHT.pdf', 'NOTICE.docx', 'LICENSE.so',
    'readme.pdf', 'CHANGELOG.docx', 'Makefile.o', 'LICENSE-MIT.7z',
  ]) {
    assert.equal(isAllowedAttachment(bare(name)), false, `${name} should be rejected`);
    assert.equal(isKnownExtensionlessTextName(name), false, name);
  }
});

test('the veto does not catch legitimate variant qualifiers', () => {
  // `.LESSER` / `.APACHE-2.0` / `.3RDPARTY` are variant markers, not
  // extensions, and none of them are on the binary list.
  for (const name of [
    'COPYING.LESSER', 'LICENSE.APACHE-2.0', 'NOTICE.3RDPARTY',
    'LICENSE.BSD', 'copying.gpl',
  ]) {
    assert.equal(isAllowedAttachment(bare(name)), true, `${name} should be accepted`);
  }
});

test('the veto does not misread a dotfile as having an extension', () => {
  // `.gitignore` must not be parsed as extension "gitignore" — the
  // leading dot is part of the name.
  assert.equal(isKnownExtensionlessTextName('.gitignore'), true);
  assert.equal(isKnownExtensionlessTextName('.editorconfig'), true);
});

test('a matching name does not override a real image', () => {
  // `notice.png` hits LICENSE_FAMILY, but images are checked first, so it
  // must still be accepted (and later treated) as an image.
  assert.equal(isAllowedAttachment(new File([''], 'notice.png', { type: 'image/png' })), true);
});

test('extension rules still win where they apply', () => {
  assert.equal(isAllowedAttachment(new File([''], 'LICENSE.txt', { type: 'text/plain' })), true);
  assert.equal(isAllowedAttachment(new File([''], 'README.md', { type: '' })), true);
});

test('a path prefix cannot defeat the name match', () => {
  assert.equal(isKnownExtensionlessTextName('some/dir/LICENSE'), true);
  assert.equal(isKnownExtensionlessTextName('C:\\repo\\NOTICE'), true);
});

test('extensionless names map to a sensible fence language', () => {
  assert.equal(langFromName('Makefile'), 'makefile');
  assert.equal(langFromName('GNUmakefile'), 'makefile');
  assert.equal(langFromName('Dockerfile'), 'dockerfile');
  assert.equal(langFromName('Gemfile'), 'ruby');
  assert.equal(langFromName('.gitignore'), 'gitignore');
  assert.equal(langFromName('.prettierrc'), 'json');
  // No invented language for prose files.
  assert.equal(langFromName('LICENSE'), '');
  assert.equal(langFromName('NOTICE'), '');
  // The extension map is untouched.
  assert.equal(langFromName('main.rs'), 'rust');
});
