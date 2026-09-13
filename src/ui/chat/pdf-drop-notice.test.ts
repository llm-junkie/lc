/**
 * Branch coverage for the dropped/picked-PDF notice, plus the ordering
 * guarantee that PDF bytes are never read.
 *
 * The point of these tests is that the message never sends the user
 * somewhere that will not work: naming `lc_read_pdf` when the tool is
 * disabled, offering a path outside the allowed roots, or — the case
 * that was actually broken — telling the user to "ask the model to read
 * it" for a web `File` whose bytes were discarded and whose path was
 * never knowable.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isPdfName, isUnderRoot, pdfDropNotice } from './pdf-drop-notice.ts';
import { partitionNativePdfPaths, resolvePickedPaths } from '../../utils/pickFiles.ts';

const READY = { toolExposed: true, allowedRoots: ['D:/docs'] };

describe('isPdfName', () => {
  it('matches regardless of case or surrounding space', () => {
    assert.ok(isPdfName('a.pdf'));
    assert.ok(isPdfName('A.PDF'));
    assert.ok(isPdfName('  report.Pdf  '));
  });

  it('does not match a name that merely contains pdf', () => {
    assert.ok(!isPdfName('pdf'));
    assert.ok(!isPdfName('notes.pdf.txt'));
    assert.ok(!isPdfName('mypdf.docx'));
  });
});

describe('isUnderRoot', () => {
  it('accepts the root itself and its descendants', () => {
    assert.ok(isUnderRoot('D:/docs', 'D:/docs'));
    assert.ok(isUnderRoot('D:/docs/a.pdf', 'D:/docs'));
    assert.ok(isUnderRoot('D:/docs/sub/a.pdf', 'D:/docs'));
  });

  it('normalizes separators and case', () => {
    assert.ok(isUnderRoot('D:\\docs\\a.pdf', 'D:/docs'));
    assert.ok(isUnderRoot('d:/DOCS/a.pdf', 'D:/docs'));
    assert.ok(isUnderRoot('D:/docs/a.pdf', 'D:/docs/'));
  });

  it('rejects a sibling whose name merely shares the prefix', () => {
    assert.ok(!isUnderRoot('D:/docs-private/a.pdf', 'D:/docs'));
    assert.ok(!isUnderRoot('D:/other/a.pdf', 'D:/docs'));
  });

  it('rejects everything for an empty root', () => {
    assert.ok(!isUnderRoot('D:/docs/a.pdf', ''));
  });
});

describe('pdfDropNotice', () => {
  it('returns null when nothing was skipped', () => {
    assert.equal(pdfDropNotice([], READY), null);
  });

  it('offers the path when the tool is ready and the file is in a root', () => {
    const msg = pdfDropNotice([{ name: 'a.pdf', path: 'D:/docs/a.pdf' }], READY)!;
    assert.match(msg, /Skipped "a\.pdf"/);
    assert.match(msg, /can't be attached/);
    assert.match(msg, /D:\/docs\/a\.pdf/);
    // Never call it unsupported — the app does support PDFs.
    assert.ok(!/unsupported/i.test(msg));
  });

  it('gives truthful guidance for a pathless file instead of naming the tool', () => {
    // The regression: a web File's bytes are discarded and it has no
    // path, so "ask the model to read it with lc_read_pdf" was advice
    // the model could not act on.
    const msg = pdfDropNotice([{ name: 'a.pdf' }], READY)!;
    assert.match(msg, /no path to give the model/);
    assert.match(msg, /Drag it in from a folder window|type its full path/);
    assert.ok(!msg.includes('D:/'), 'no path may be invented');
  });

  it('points at Tools settings when every file is outside the roots', () => {
    const msg = pdfDropNotice([{ name: 'a.pdf', path: 'C:/Downloads/a.pdf' }], READY)!;
    assert.match(msg, /isn't an allowed root/);
    assert.match(msg, /C:\/Downloads/);
    assert.match(msg, /Tools settings/);
  });

  it('says the tool is disabled rather than offering it', () => {
    const msg = pdfDropNotice([{ name: 'a.pdf', path: 'D:/docs/a.pdf' }], {
      toolExposed: false,
      allowedRoots: ['D:/docs'],
    })!;
    assert.match(msg, /isn't enabled for this conversation/);
    assert.ok(!/Ask the model/.test(msg));
  });

  it('accounts for out-of-root files in a mixed batch instead of dropping them', () => {
    // The regression: only the readable path was listed, so the
    // inaccessible file vanished from the message entirely.
    const msg = pdfDropNotice(
      [
        { name: 'in.pdf', path: 'D:/docs/in.pdf' },
        { name: 'out.pdf', path: 'C:/Downloads/out.pdf' },
      ],
      READY,
    )!;
    assert.match(msg, /D:\/docs\/in\.pdf/, 'the readable path is offered');
    assert.match(msg, /out\.pdf/, 'the inaccessible file is still named');
    assert.match(msg, /outside your allowed roots/);
    assert.match(msg, /C:\/Downloads/);
  });

  it('accounts for pathless files alongside readable ones', () => {
    const msg = pdfDropNotice(
      [{ name: 'in.pdf', path: 'D:/docs/in.pdf' }, { name: 'web.pdf' }],
      READY,
    )!;
    assert.match(msg, /D:\/docs\/in\.pdf/);
    assert.match(msg, /web\.pdf/);
    assert.match(msg, /without a path/);
  });

  it('summarizes several PDFs and lists their paths', () => {
    const msg = pdfDropNotice(
      [
        { name: 'a.pdf', path: 'D:/docs/a.pdf' },
        { name: 'b.pdf', path: 'D:/docs/b.pdf' },
      ],
      READY,
    )!;
    assert.match(msg, /2 PDFs/);
    assert.match(msg, /read them/);
    assert.match(msg, /D:\/docs\/a\.pdf/);
    assert.match(msg, /D:\/docs\/b\.pdf/);
  });

  it('elides the name list beyond three', () => {
    const many = ['a', 'b', 'c', 'd'].map((n) => ({ name: `${n}.pdf`, path: `D:/docs/${n}.pdf` }));
    const msg = pdfDropNotice(many, READY)!;
    assert.match(msg, /4 PDFs/);
    assert.match(msg, /…/);
  });
});

/* ------------------------------------------------------------------ */
/*  Native picker: PDF bytes must never be read                        */
/* ------------------------------------------------------------------ */

describe('native picker PDF short-circuit', () => {
  const fakeFile = (p: string) =>
    Promise.resolve(new File([new Uint8Array([1, 2, 3])], p.split(/[\\/]/).pop()!));

  it('never reads a picked PDF, and returns its path instead', async () => {
    // The regression: the picker called read_dropped_file for every
    // selection, so a PDF was fully loaded, rejected, and its path lost.
    const read: string[] = [];
    const out = await resolvePickedPaths(
      async () => ['D:/docs/a.pdf', 'D:/docs/notes.txt'],
      async (p) => { read.push(p); return fakeFile(p); },
    );
    assert.deepEqual(read, ['D:/docs/notes.txt'], 'only the non-PDF may be read');
    assert.deepEqual(out.pdfPaths, ['D:/docs/a.pdf']);
    assert.equal(out.files.length, 1);
  });

  it('reads nothing when every selection is a PDF', async () => {
    const read: string[] = [];
    const out = await resolvePickedPaths(
      async () => ['D:/docs/a.pdf', 'D:/docs/b.PDF'],
      async (p) => { read.push(p); return fakeFile(p); },
    );
    assert.deepEqual(read, [], 'no PDF bytes may be read');
    assert.equal(out.pdfPaths.length, 2);
    assert.equal(out.files.length, 0);
  });

  it('handles a single non-array selection', async () => {
    const out = await resolvePickedPaths(async () => 'D:/docs/a.pdf', fakeFile);
    assert.deepEqual(out.pdfPaths, ['D:/docs/a.pdf']);
  });

  it('returns empty collections on cancel', async () => {
    const out = await resolvePickedPaths(async () => null, fakeFile);
    assert.deepEqual(out, { files: [], pdfPaths: [] });
  });
});

describe('native drop PDF short-circuit', () => {
  it('partitions PDFs before either chat surface reads any bytes', () => {
    const out = partitionNativePdfPaths([
      'D:/docs/a.pdf',
      'D:/docs/notes.txt',
      'D:/docs/B.PDF',
      'D:/docs/photo.png',
    ]);
    assert.deepEqual(out.pdfPaths, ['D:/docs/a.pdf', 'D:/docs/B.PDF']);
    assert.deepEqual(out.otherPaths, ['D:/docs/notes.txt', 'D:/docs/photo.png']);
  });
});
