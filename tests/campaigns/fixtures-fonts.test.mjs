import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FONT_SOURCES, LICENSE_SOURCES, NORMAL_FACE_IDS, inspectStaticFace, produceFontCorpus } from '../../tooling/qualification/campaigns/fonts.mjs';

test('qualification font producer pins sixteen distinct official static faces and four normal identities',async()=>{assert.equal(FONT_SOURCES.length,16);assert.equal(new Set(FONT_SOURCES.map(f=>f.id)).size,16);assert.equal(NORMAL_FACE_IDS.length,4);assert(FONT_SOURCES.every(f=>/^https:\/\/raw\.githubusercontent\.com\/notofonts\/(noto-fonts|noto-cjk)\/[a-f0-9]{40}\//.test(f.url)));const lock=JSON.parse(await readFile(new URL('../../tooling/qualification/campaigns/fonts.lock.json',import.meta.url)));assert.equal(lock.faces.length,16);assert.equal(new Set(lock.faces.map(f=>f.sha256)).size,16);assert.equal(lock.licenses.length,LICENSE_SOURCES.length);assert(lock.faces.every(f=>/^sha256:[a-f0-9]{64}$/.test(f.sha256)&&BigInt(f.byteLength)>0n));});
test('font acquisition is explicitly opt-in and malformed bytes cannot pass static preflight',async()=>{await assert.rejects(produceFontCorpus({output:'/tmp/no-font-download'}),/allowNetwork/);for(const input of [Buffer.alloc(0),Buffer.from('ttcf'),Buffer.alloc(100)])assert.throws(()=>inspectStaticFace(input));});
