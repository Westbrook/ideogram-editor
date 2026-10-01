import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical } from '../../dist/local/src/protocol/json.js';
import { loadProviderConfiguration, validateProviderRuntimeConfiguration, ProviderConfigurationError } from '../../dist/local/server/provider/config.js';
import { PRODUCTION_PRIVACY, PRODUCTION_PROFILE } from '../../dist/local/server/provider/production-profile.js';
import { egressAttempts } from './no-egress.mjs';

const now = Date.UTC(2026, 8, 30, 15);
const sentinel = 'fal-config-sentinel-not-a-credential';
function approved(overrides = {}) {
  return { schemaVersion: 1, id: 'local-pilot-1', approvedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(), endpoint: 'ideogram/v4', operation: 'generate',
    maxRequests: 2, maxImages: 2, output: { width: 1024, height: 1024, count: 1, format: 'png' },
    expansion: 'None', profileId: PRODUCTION_PROFILE.id, profileVersion: PRODUCTION_PROFILE.version,
    evidenceDigest: PRODUCTION_PROFILE.evidenceDigest, disclosureDigest: PRODUCTION_PRIVACY.disclosureDigest,
    acknowledgeChargeAndPrivacy: true, ...overrides };
}
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ie-fal-config-')));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const approval = join(root, 'approval.json'), key = join(root, 'key.txt');
  const writeApproval = (value = approved()) => writeFileSync(approval,
    typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value), { mode: 0o600 });
  const writeKey = (value = sentinel) => writeFileSync(key, value, { mode: 0o600 });
  writeApproval(); writeKey();
  return { root, approval, key, writeApproval, writeKey,
    env: { IDEOGRAM_PROVIDER_MODE: 'fal', IDEOGRAM_FAL_APPROVAL_FILE: approval, FAL_KEY_FILE: key } };
}
function rejected(env, time = now) {
  assert.throws(() => loadProviderConfiguration(env, time), error => {
    assert.ok(error instanceof ProviderConfigurationError);
    assert.equal(error.name, 'ProviderConfigurationError');
    assert.equal(error.code, 'PROVIDER_CONFIGURATION_INVALID');
    assert.equal(error.message, 'Provider configuration is invalid.');
    assert.equal(error.cause, undefined);
    assert.equal(JSON.stringify(error).includes(sentinel), false);
    return true;
  });
}

test('provider access defaults off without touching approval or credential channels', () => {
  for (const mode of [undefined, 'disabled']) {
    const env = { IDEOGRAM_PROVIDER_MODE: mode };
    for (const key of ['IDEOGRAM_FAL_APPROVAL_FILE', 'FAL_KEY_FILE', 'FAL_KEY']) {
      Object.defineProperty(env, key, { get() { throw Error('disabled mode read ' + key); } });
    }
    const config = loadProviderConfiguration(env, now);
    assert.deepEqual(config, { mode: 'disabled' });
    assert.ok(Object.isFrozen(config));
  }
  assert.deepEqual(loadProviderConfiguration({ FAL_KEY: sentinel }, now), { mode: 'disabled' });
  for (const mode of ['', 'true', 'production', 'FAL', 'fixture', 'fal ']) rejected({ IDEOGRAM_PROVIDER_MODE: mode });
});

test('explicit valid configuration binds immutable manifest identity and reads only the selected key file', t => {
  const f = fixture(t);
  Object.defineProperty(f.env, 'FAL_KEY', { get() { throw Error('legacy FAL_KEY must not be read'); } });
  const config = loadProviderConfiguration(f.env, now);
  assert.equal(config.mode, 'fal');
  assert.equal(config.key, sentinel);
  assert.deepEqual(config.manifest, approved());
  assert.equal(config.manifestHash, createHash('sha256').update(canonical(approved())).digest('hex'));
  for (const value of [config, config.manifest, config.manifest.output]) assert.ok(Object.isFrozen(value));
  assert.throws(() => { config.manifest.output.width = 512; }, TypeError);
  f.writeApproval(JSON.stringify(Object.fromEntries(Object.entries(approved()).reverse()), null, 2));
  assert.equal(loadProviderConfiguration(f.env, now).manifestHash, config.manifestHash);
  f.writeApproval(approved({ id: 'local-pilot-2' }));
  assert.notEqual(loadProviderConfiguration(f.env, now).manifestHash, config.manifestHash);
});

test('enabled mode needs explicit local approval and key file; environment keys cannot substitute', t => {
  const f = fixture(t);
  rejected({ IDEOGRAM_PROVIDER_MODE: 'fal', FAL_KEY: sentinel });
  rejected({ ...f.env, IDEOGRAM_FAL_APPROVAL_FILE: undefined });
  rejected({ ...f.env, FAL_KEY_FILE: undefined, FAL_KEY: sentinel });
  rejected({ ...f.env, FAL_KEY_FILE: join(f.root, sentinel) });
  rejected({ ...f.env, IDEOGRAM_FAL_APPROVAL_FILE: join(f.root, sentinel) });
});

test('approval has exact fields and rejects malformed, duplicate-key and non-UTF8 JSON without echoing input', t => {
  const f = fixture(t);
  for (const source of ['', 'null', '[]', '{', JSON.stringify({ ...approved(), key: sentinel }),
    JSON.stringify(approved()).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    JSON.stringify(approved()).replace('"schemaVersion":1', '"schemaVersion":1,"schema\\u0056ersion":1'),
    JSON.stringify(approved()).replace('"maxRequests":2', '"maxRequests":1e999'),
    JSON.stringify(approved()).replace('"id":"local-pilot-1"', '"id":"\\ud800"'),
    Buffer.from([0xff, 0xfe])]) {
    f.writeApproval(source); rejected(f.env);
  }
  for (const field of Object.keys(approved())) {
    const value = approved(); delete value[field]; f.writeApproval(value); rejected(f.env);
  }
});

test('approval allows only Generate image with one PNG at explicit eligible dimensions', t => {
  const f = fixture(t);
  for (const change of [{ schemaVersion: 2 }, { id: '' }, { id: 'x'.repeat(129) }, { id: '../pilot' },
    { operation: 'inpaint' }, { endpoint: 'ideogram/v4/instant' }, { expansion: 'Medium' },
    { acknowledgeChargeAndPrivacy: false }, { acknowledgeChargeAndPrivacy: 'true' },
    ...[0, -1, 101, 1.5, '1'].map(maxRequests => ({ maxRequests })),
    ...[0, -1, 401, 1.5, '1'].map(maxImages => ({ maxImages })),
    ...[null, 'custom', {}, { width: 1024, height: 1024, count: 1, format: 'png', seed: 1 },
      ...[0, 511, 513, 3856, 1024.5, '1024'].map(width => ({ width, height: 1024, count: 1, format: 'png' })),
      { width: 1024, height: 1024, count: 2, format: 'png' },
      { width: 1024, height: 1024, count: 1, format: 'jpeg' }].map(output => ({ output }))]) {
    f.writeApproval(approved(change)); rejected(f.env);
  }
  for (const side of [512, 3840]) {
    f.writeApproval(approved({ maxRequests: 100, maxImages: 400, output: { width: side, height: side, count: 1, format: 'png' } }));
    assert.equal(loadProviderConfiguration(f.env, now).manifest.output.width, side);
  }
});

test('approval binds current sealed privacy profile and disclosure', t => {
  const f = fixture(t);
  for (const change of [{ profileId: 'caller-profile' }, { profileVersion: PRODUCTION_PROFILE.version + 1 },
    { evidenceDigest: 'wrong-evidence' }, { disclosureDigest: 'wrong-disclosure' },
    { profile: { ...PRODUCTION_PROFILE, acl: 'caller-acl' } }, { mediaOrigins: ['https://example.com'] }]) {
    f.writeApproval(approved(change)); rejected(f.env);
  }
});

test('approval requires canonical UTC timestamps and a reached approval time; expired identity remains available for recovery', t => {
  const f = fixture(t);
  for (const change of [{ approvedAt: new Date(now + 1).toISOString() },
    { expiresAt: new Date(now - 1000).toISOString() }, { expiresAt: new Date(now - 1001).toISOString() },
    { approvedAt: now - 1 }, { expiresAt: Infinity }, { expiresAt: 'not-a-date' },
    { expiresAt: '2026-10-01T00:00:00Z' }, { expiresAt: '2026-10-01T00:00:00.000+00:00' },
    { expiresAt: '2026-02-30T00:00:00.000Z' }]) {
    f.writeApproval(approved(change)); rejected(f.env);
  }
  f.writeApproval(approved({ approvedAt: new Date(now).toISOString(), expiresAt: new Date(now + 1).toISOString() }));
  assert.equal(loadProviderConfiguration(f.env, now).mode, 'fal');
  assert.equal(loadProviderConfiguration(f.env, now + 1).mode, 'fal');
  f.writeApproval(approved({ expiresAt: new Date(now - 1).toISOString() }));
  const expired = loadProviderConfiguration(f.env, now);
  assert.equal(expired.mode, 'fal');
  assert.ok(Date.parse(expired.manifest.expiresAt) < now);
  for (const time of [NaN, Infinity, now + 0.5]) rejected(f.env, time);
});

test('approval and key reads are bounded before parsing', t => {
  const f = fixture(t), json = JSON.stringify(approved());
  f.writeApproval(json.padEnd(64 * 1024, ' '));
  assert.equal(loadProviderConfiguration(f.env, now).mode, 'fal');
  f.writeApproval(json.padEnd(64 * 1024 + 1, ' ')); rejected(f.env);
  f.writeApproval(); f.writeKey('x'.repeat(4096));
  assert.equal(loadProviderConfiguration(f.env, now).key.length, 4096);
  f.writeKey('x'.repeat(4097)); rejected(f.env);
});

test('key file permits a single line terminator but no whitespace, controls, BOM or non-ASCII', t => {
  const f = fixture(t);
  for (const suffix of ['', '\n', '\r\n']) {
    f.writeKey(sentinel + suffix); assert.equal(loadProviderConfiguration(f.env, now).key, sentinel);
  }
  for (const key of ['', '\n', sentinel + '\n\n', sentinel + '\r', ' ' + sentinel, sentinel + ' ',
    sentinel + '\t', sentinel + '\0', '\ufeff' + sentinel, 'é' + sentinel, Buffer.from([0xff])]) {
    f.writeKey(key); rejected(f.env);
  }
});

test('both files must be owner-only regular single-link files with safe absolute paths', t => {
  const f = fixture(t);
  for (const field of ['IDEOGRAM_FAL_APPROVAL_FILE', 'FAL_KEY_FILE']) {
    const path = f.env[field];
    for (const mode of [0o644, 0o640, 0o400, 0o700, 0o4600]) {
      chmodSync(path, mode); rejected(f.env); chmodSync(path, 0o600);
    }
    const hardlink = join(f.root, 'hardlink'); linkSync(path, hardlink);
    rejected(f.env); unlinkSync(hardlink);
    const symlink = join(f.root, 'symlink'); symlinkSync(path, symlink);
    rejected({ ...f.env, [field]: symlink }); unlinkSync(symlink);
    for (const unsafe of ['relative-file', path + '\0', f.root + '/./' + path.slice(f.root.length + 1), f.root]) {
      rejected({ ...f.env, [field]: unsafe });
    }
  }
  const nested = join(f.root, 'nested'), alias = join(f.root, 'alias');
  mkdirSync(nested, { mode: 0o700 });
  writeFileSync(join(nested, 'key'), sentinel, { mode: 0o600 }); symlinkSync(nested, alias);
  rejected({ ...f.env, FAL_KEY_FILE: join(alias, 'key') });
  for (const mode of [0o770, 0o777]) {
    chmodSync(nested, mode); rejected({ ...f.env, FAL_KEY_FILE: join(nested, 'key') });
  }
  chmodSync(nested, 0o1777);
  assert.equal(loadProviderConfiguration({ ...f.env, FAL_KEY_FILE: join(nested, 'key') }, now).mode, 'fal');
  assert.equal(loadProviderConfiguration(f.env, now).mode, 'fal');
});

test('worker configuration revalidation requires exact fields, sealed manifest, matching hash and header-safe key', t => {
  const f = fixture(t), config = loadProviderConfiguration(f.env, now);
  const clone = structuredClone(config), validated = validateProviderRuntimeConfiguration(clone, now);
  assert.deepEqual(validated, config);
  assert.notEqual(validated, clone);
  assert.notEqual(validated.manifest, clone.manifest);
  for (const value of [validated, validated.manifest, validated.manifest.output]) assert.ok(Object.isFrozen(value));
  assert.deepEqual(validateProviderRuntimeConfiguration({ mode: 'disabled' }, now), { mode: 'disabled' });
  const invalidManifest = approved({ endpoint: 'ideogram/v4/instant' });
  for (const value of [null, [], {}, { mode: 'disabled', key: sentinel }, { ...clone, unexpected: sentinel },
    { ...clone, mode: 'fixture' }, { ...clone, key: '' }, { ...clone, key: sentinel + '\r\n' },
    { ...clone, key: 'x'.repeat(4097) }, { ...clone, manifestHash: 'a'.repeat(64) },
    { ...clone, manifest: { ...clone.manifest, id: 'changed' } },
    { ...clone, manifest: invalidManifest, manifestHash: createHash('sha256').update(canonical(invalidManifest)).digest('hex') }]) {
    assert.throws(() => validateProviderRuntimeConfiguration(value, now), error => {
      assert.ok(error instanceof ProviderConfigurationError);
      assert.equal(error.code, 'PROVIDER_CONFIGURATION_INVALID');
      assert.equal(error.message, 'Provider configuration is invalid.');
      assert.equal(JSON.stringify(error).includes(sentinel), false);
      return true;
    });
  }
  // Submission expiry is enforced by runtime authorization, not by deleting recovery identity.
  assert.deepEqual(validateProviderRuntimeConfiguration(clone, now + 60000), config);
});

test('configuration does not initiate provider network access', () => assert.deepEqual(egressAttempts(), []));
