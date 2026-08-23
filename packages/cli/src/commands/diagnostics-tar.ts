// SPDX-License-Identifier: Apache-2.0
/**
 * A minimal USTAR writer, gzipped with `node:zlib`.
 *
 * ## Why not a tar library
 *
 * Adding one would mean a new runtime dependency on the CLI, a regenerated
 * lockfile and a regenerated NOTICE — real supply-chain surface for a support
 * tool whose entire job is to be safe to hand to a stranger. USTAR is a
 * fixed-width header and 512-byte blocks; the writer below is short enough to
 * read in full, and `zlib` is already in Node.
 *
 * This writes the subset a support bundle needs: regular files, no symlinks,
 * no directories, no long-name extensions. Anything outside that subset is
 * REFUSED rather than silently truncated — a bundle that quietly dropped a
 * file would be worse than one that failed to build.
 */

import { gzipSync } from 'node:zlib';

const BLOCK = 512;

/** USTAR caps the name field at 100 bytes; longer needs a PAX extension. */
const MAX_NAME_BYTES = 100;

export interface TarEntry {
  readonly name: string;
  readonly content: string;
}

export class TarNameTooLongError extends Error {
  constructor(name: string) {
    super(
      `Bundle entry name is too long for USTAR (${Buffer.byteLength(name)} > ${MAX_NAME_BYTES} bytes): ${name}`,
    );
    this.name = 'TarNameTooLongError';
  }
}

/**
 * Build a gzipped tar archive from in-memory entries.
 *
 * Everything is held in memory deliberately: a support bundle is kilobytes of
 * JSON, and streaming would buy nothing while making the redaction boundary
 * harder to reason about — every byte here has already been through the
 * pipeline before it reaches this function.
 */
export function createTarGz(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = [];

  for (const entry of entries) {
    const content = Buffer.from(entry.content, 'utf8');
    blocks.push(header(entry.name, content.length));
    blocks.push(content);

    const remainder = content.length % BLOCK;
    if (remainder !== 0) blocks.push(Buffer.alloc(BLOCK - remainder));
  }

  // Two zero blocks mark end-of-archive. Without them `tar` reports an
  // unexpected EOF, which reads to an operator as a corrupt bundle.
  blocks.push(Buffer.alloc(BLOCK * 2));

  return gzipSync(Buffer.concat(blocks));
}

function header(name: string, size: number): Buffer {
  if (Buffer.byteLength(name) > MAX_NAME_BYTES) throw new TarNameTooLongError(name);

  const buf = Buffer.alloc(BLOCK);

  buf.write(name, 0, MAX_NAME_BYTES, 'utf8');
  buf.write('000644 \0', 100, 8, 'utf8'); // mode
  buf.write('000000 \0', 108, 8, 'utf8'); // uid
  buf.write('000000 \0', 116, 8, 'utf8'); // gid
  buf.write(`${octal(size, 11)} `, 124, 12, 'utf8');

  // mtime is fixed at the epoch, NOT the current time.
  //
  // Two bundles built from identical inputs then produce byte-identical
  // archives, which is what lets a test assert on the bytes and lets an
  // operator diff two bundles meaningfully. A wall-clock mtime would make
  // every archive unique for a field nobody reads — the real timestamp is in
  // the bundle's own metadata, where it is visible.
  buf.write(`${octal(0, 11)} `, 136, 12, 'utf8');

  buf.write('        ', 148, 8, 'utf8'); // checksum placeholder: 8 spaces
  buf.write('0', 156, 1, 'utf8'); // type flag: regular file
  buf.write('ustar\0', 257, 6, 'utf8');
  buf.write('00', 263, 2, 'utf8');

  // Checksum is computed with the field itself read as spaces, which is why
  // it is written last and why the placeholder above is exactly 8 spaces.
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(`${octal(sum, 6)}\0 `, 148, 8, 'utf8');

  return buf;
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width, '0');
}
