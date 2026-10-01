import test from 'node:test';
import assert from 'node:assert/strict';

test('included [exact] case', () => assert.equal(2 + 2, 4));
test('separate required case', () => assert.equal('retained'.length, 8));
