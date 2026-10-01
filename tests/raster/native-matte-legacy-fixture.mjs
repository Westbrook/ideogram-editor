// Frozen export pixel branch captured before the native-size row matte path.
// This deliberately retains the prior 128-square traversal and FilePixels
// cache. The CP1 arithmetic import is the unchanged sealed kernel, shared by
// the original branch; do not replace this traversal with the production path.
import { openSync, closeSync, readSync, writeSync, fsyncSync, fstatSync, constants } from 'node:fs';
import { dirname } from 'node:path';
import { assertComponents, assertPrivate, sameFile } from '../../dist/local/server/storage/files.js';
import { contribution, linear, srgb, q8 } from '../../dist/local/src/raster/core.js';

function inputFD(path) {
  assertComponents(dirname(path)); const before = assertPrivate(path, false), fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  if (!sameFile(before, fstatSync(fd))) { closeSync(fd); throw Error('RASTER_INPUT_CHANGED'); }
  return fd;
}

class FilePixels {
  constructor(width, height, path) {
    this.width = width; this.height = height; this.rows = new Map(); this.fd = inputFD(path);
    if (fstatSync(this.fd).size !== width * height * 4) { closeSync(this.fd); throw Error('RASTER_LENGTH'); }
  }
  get(x, y, into) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) { into.fill(0); return; }
    let row = this.rows.get(y);
    if (!row) {
      if (this.rows.size >= 32) { const oldest = this.rows.keys().next().value; row = this.rows.get(oldest); this.rows.delete(oldest); }
      else row = Buffer.alloc(this.width * 4);
      if (readSync(this.fd, row, 0, row.length, y * row.length) !== row.length) throw Error('RASTER_LENGTH');
      this.rows.set(y, row);
    }
    for (let c = 0; c < 4; c++) into[c] = row[x * 4 + c];
  }
  close() { closeSync(this.fd); this.rows.clear(); }
}

function writeAll(fd, bytes, position) {
  for (let at = 0; at < bytes.length;) {
    const n = writeSync(fd, bytes, at, bytes.length - at, position + at);
    if (!n) throw Error('RASTER_WRITE'); at += n;
  }
}
function writeTile(fd, width, rect, bytes) {
  for (let y = 0; y < rect.height; y++) writeAll(fd, bytes.subarray(y * rect.width * 4, (y + 1) * rect.width * 4), ((rect.y + y) * width + rect.x) * 4);
}

export async function legacyExportPixels(input, raw, width, height, matteHex, check = () => {}) {
  const source = new FilePixels(input.width, input.height, input.path);
  const transform = [width / source.width, 0, 0, height / source.height, 0, 0];
  const matte = matteHex ? [1, 3, 5].map(i => linear(parseInt(matteHex.slice(i, i + 2), 16) / 255)) : null;
  let target;
  try {
    target = openSync(raw, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    for (let y = 0; y < height; y += 128) for (let x = 0; x < width; x += 128) {
      check(); const rect = { x, y, width: Math.min(128, width - x), height: Math.min(128, height - y) };
      const bytes = contribution(source, rect, transform, 1);
      if (matte) for (let i = 0; i < bytes.length; i += 4) {
        const alpha = bytes[i + 3] / 255;
        for (let c = 0; c < 3; c++) bytes[i + c] = q8(srgb(linear(bytes[i + c] / 255) * alpha + matte[c] * (1 - alpha)));
        bytes[i + 3] = 255;
      }
      writeTile(target, width, rect, bytes);
      await new Promise(resolve => setImmediate(resolve));
    }
    fsyncSync(target);
  } finally { source.close(); if (target !== undefined) closeSync(target); }
}
