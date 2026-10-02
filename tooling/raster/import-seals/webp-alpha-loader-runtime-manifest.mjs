// Retained-data checks for the reviewed dependency snapshot format. Original
// paths are provenance labels only; no dependency, path, or source is opened.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {posix} from 'node:path';

const HASH = /^sha256:[a-f0-9]{64}$/;
const ROOT = 'node_modules';
// A campaign is read through an 8 MiB held-JSON boundary. This necessary compact
// bound does not introduce a smaller arbitrary limit on dependency entry count.
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const within = (root, path) => path === root || path.startsWith(root + '/');

function keys(value, expected, label) {
  assert(value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)),
    label + ' must be a record');
  assert.deepEqual(Reflect.ownKeys(value).sort(), expected.slice().sort(), label + ' fields differ');
}

function text(value, label) {
  assert(typeof value === 'string' && value.length > 0 && !value.includes('\0') && !value.includes('\\'),
    label + ' must be a nonempty POSIX string');
  assert.equal(Buffer.from(value, 'utf8').toString('utf8'), value, label + ' is not lossless UTF-8');
  return value;
}

function repositoryPath(value) {
  text(value, 'Dependency path');
  assert(!posix.isAbsolute(value) && value.split('/').every(part => part && part !== '.' && part !== '..'),
    'Dependency path must be normalized and relative');
  assert(within(ROOT, value), 'Dependency path escaped node_modules');
  return value;
}

function orderedRows(rows, expected, label, visit) {
  assert(Array.isArray(rows), label + ' must be an array');
  let previous;
  for (const row of rows) {
    keys(row, expected, label + ' row');
    repositoryPath(row.repositoryPath);
    assert(previous === undefined || previous < row.repositoryPath, label + ' paths must be strictly ordered');
    previous = row.repositoryPath;
    visit(row);
  }
}

// This is deliberately the dependency producer's sorted JSON.stringify
// dialect, including UTF-16 key sorting and JSON.stringify control escaping.
// The protocol canonical serializer is a different identity contract.
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, sorted(value[key])]));
  return value;
}

/** Validate recorded membership and identity, never current installed bytes. */
export function validateAlphaRuntimeManifest(manifest, {repo, platform}) {
  keys(manifest, ['method', 'files', 'links', 'directories', 'identityHash'], 'Runtime manifest');
  text(repo, 'Original repository');
  assert(posix.isAbsolute(repo) && posix.resolve(repo) === repo, 'Original repository must be normalized and absolute');
  assert(platform === 'darwin' || platform === 'linux', 'Unsupported dependency snapshot platform');
  assert.equal(manifest.method, platform === 'linux' ? 'directory-fd-anchored-v1' : 'held-nofollow-path-snapshot-v1',
    'Dependency snapshot method differs from original host platform');
  assert.match(manifest.identityHash, HASH);
  const physical = new Map();
  const add = (row, kind) => {
    assert(!physical.has(row.repositoryPath), 'Conflicting dependency entry kinds');
    physical.set(row.repositoryPath, {kind, row});
  };
  orderedRows(manifest.files, ['repositoryPath', 'bytes', 'hash'], 'Dependency files', row => {
    assert(row.repositoryPath !== ROOT, 'Dependency root cannot be a file');
    assert(Number.isSafeInteger(row.bytes) && row.bytes >= 0, 'Invalid dependency byte count');
    assert.match(row.hash, HASH);
    add(row, 'file');
  });
  orderedRows(manifest.links, ['repositoryPath', 'target', 'resolvedRepositoryPath'], 'Dependency links', row => {
    assert(row.repositoryPath !== ROOT, 'Dependency root cannot be a link');
    text(row.target, 'Dependency link target');
    assert(!row.target.endsWith('/'), 'Dependency link target has a trailing separator');
    assert.equal(posix.normalize(row.target), row.target, 'Dependency link target is not canonical');
    repositoryPath(row.resolvedRepositoryPath);
    add(row, 'link');
  });
  orderedRows(manifest.directories, ['repositoryPath'], 'Dependency directories', row => add(row, 'directory'));
  assert.equal(physical.get(ROOT)?.kind, 'directory', 'Dependency root directory is missing');
  for (const path of physical.keys()) {
    if (path === ROOT) continue;
    assert.equal(physical.get(posix.dirname(path))?.kind, 'directory',
      'Dependency entry has a missing or non-directory physical parent');
  }

  const originalRoot = posix.join(repo, ROOT);
  const pendingTarget = target => {
    if (!posix.isAbsolute(target)) return target.split('/');
    assert.equal(posix.resolve(target), target, 'Absolute dependency target is not canonical');
    assert(within(originalRoot, target), 'Absolute dependency target escaped original node_modules');
    return posix.relative(originalRoot, target).split('/');
  };
  const linkTarget = row => ({
    cursor: posix.isAbsolute(row.target) ? ROOT : posix.dirname(row.repositoryPath),
    pending: pendingTarget(row.target),
  });
  for (const row of manifest.links) {
    let {cursor, pending} = linkTarget(row), hops = 1;
    while (pending.length) {
      const part = pending.shift();
      if (part === '' || part === '.') continue;
      if (part === '..') {
        cursor = posix.dirname(cursor);
        assert(within(ROOT, cursor), 'Dependency link traversed outside node_modules');
        continue;
      }
      const current = posix.join(cursor, part), entry = physical.get(current);
      assert(entry, 'Dependency link has a missing target');
      if (entry.kind === 'link') {
        assert(++hops <= 8, 'Cyclic or excessive dependency link chain');
        const next = linkTarget(entry.row);
        cursor = next.cursor;
        pending = [...next.pending, ...pending];
      } else {
        if (pending.some(value => value !== '' && value !== '.')) {
          assert.equal(entry.kind, 'directory', 'Dependency link traversed a non-directory');
        }
        cursor = current;
      }
    }
    assert(within(ROOT, cursor), 'Resolved dependency link escaped node_modules');
    const final = physical.get(cursor);
    assert(final && (final.kind === 'directory' || final.kind === 'file'), 'Dependency link has a nonregular target');
    assert.equal(row.resolvedRepositoryPath, cursor, 'Dependency link resolved path differs');
  }

  const {method, files, links, directories} = manifest;
  const definition = JSON.stringify(sorted({method, files, links, directories}));
  assert(Buffer.byteLength(definition, 'utf8') <= MAX_MANIFEST_BYTES, 'Runtime manifest exceeds retained JSON bound');
  assert.equal(manifest.identityHash, hash(definition), 'Runtime dependency identity differs');
  return {method, identityHash: manifest.identityHash, files: files.length, links: links.length, directories: directories.length};
}
