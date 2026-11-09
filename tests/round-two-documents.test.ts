import { describe, expect, it } from 'vitest';
import { validateAnalysisDocument } from '../src/round-two-documents';

const encoder = new TextEncoder();

function checksum(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function write16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, true);
}

function write32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value, true);
}

function storedZip(entries: Record<string, string>) {
  const local: Uint8Array[] = [],
    central: Uint8Array[] = [];
  let localOffset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const filename = encoder.encode(name),
      content = encoder.encode(text),
      crc = checksum(content),
      localHeader = new Uint8Array(30 + filename.length + content.length),
      localView = new DataView(localHeader.buffer);
    write32(localView, 0, 0x04034b50);
    write16(localView, 4, 20);
    write32(localView, 14, crc);
    write32(localView, 18, content.length);
    write32(localView, 22, content.length);
    write16(localView, 26, filename.length);
    localHeader.set(filename, 30);
    localHeader.set(content, 30 + filename.length);
    local.push(localHeader);

    const centralHeader = new Uint8Array(46 + filename.length),
      centralView = new DataView(centralHeader.buffer);
    write32(centralView, 0, 0x02014b50);
    write16(centralView, 4, 20);
    write16(centralView, 6, 20);
    write32(centralView, 16, crc);
    write32(centralView, 20, content.length);
    write32(centralView, 24, content.length);
    write16(centralView, 28, filename.length);
    write32(centralView, 42, localOffset);
    centralHeader.set(filename, 46);
    central.push(centralHeader);
    localOffset += localHeader.length;
  }

  const centralSize = central.reduce((sum, entry) => sum + entry.length, 0),
    end = new Uint8Array(22),
    endView = new DataView(end.buffer);
  write32(endView, 0, 0x06054b50);
  write16(endView, 8, central.length);
  write16(endView, 10, central.length);
  write32(endView, 12, centralSize);
  write32(endView, 16, localOffset);
  return Uint8Array.from(
    [...local, ...central, end].flatMap((part) => [...part]),
  );
}

describe('analysis document validation', () => {
  it('accepts PDF bytes and a DOCX package with required Word parts', () => {
    const docx = storedZip({
      '[Content_Types].xml':
        '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      'word/document.xml': '<w:document></w:document>',
    });

    expect(
      validateAnalysisDocument(
        'analysis.pdf',
        Uint8Array.from(encoder.encode('%PDF-1.7\n')),
      ),
    ).toEqual({ contentType: 'application/pdf' });
    expect(validateAnalysisDocument('analysis.docx', docx)).toEqual({
      contentType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
  });

  it('rejects mismatched signatures and incomplete DOCX archives', () => {
    const notADocx = storedZip({
      '[Content_Types].xml': '<Types></Types>',
      'readme.txt': 'not a Word document',
    });

    expect(() =>
      validateAnalysisDocument('analysis.pdf', encoder.encode('not PDF')),
    ).toThrow('DOCUMENT_TYPE_INVALID');
    expect(() => validateAnalysisDocument('analysis.docx', notADocx)).toThrow(
      'DOCUMENT_TYPE_INVALID',
    );
    expect(() =>
      validateAnalysisDocument('analysis.exe', encoder.encode('%PDF-1.7')),
    ).toThrow('DOCUMENT_TYPE_INVALID');
  });

  it('rejects analysis documents larger than 2 MiB', () => {
    expect(() =>
      validateAnalysisDocument(
        'analysis.pdf',
        new Uint8Array(2 * 1024 * 1024 + 1),
      ),
    ).toThrow('DOCUMENT_LIMIT');
  });
});
