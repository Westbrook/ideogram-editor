import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {hash,identity} from './files.mjs';

const targets=Object.freeze({'darwin-arm64':{module:'identity.ts',alias:'MAC'},'linux-arm64':{module:'identities/linux-arm64-v1.ts',alias:'LINUX_ARM64'},'linux-x64':{module:'identities/linux-x64-v1.ts',alias:'LINUX_X64'}});
/** Read only the frozen JSON literal; never execute an identity from a capsule. */
export function authoritativeCodec(root,platform,arch){const target=targets[platform+'-'+arch];assert(target,'Unsupported import platform');const sourcePath='server/raster/'+target.module,registryPath='server/raster/codec-platform.ts',source=readFileSync(join(root,sourcePath),'utf8'),registry=readFileSync(join(root,registryPath),'utf8'),literal=source.match(/export const CODECS = (\{[\s\S]*\}) as const;/),id=source.match(/export const CODEC_ID = ['"](sha256:[a-f0-9]{64})['"]/);assert(literal&&id);const codecs=JSON.parse(literal[1]);assert.equal(codecs.platform,platform);assert.equal(codecs.arch,arch);assert.equal(hash(JSON.stringify(codecs)),id[1]);assert(registry.includes(`import { CODECS as ${target.alias}_CODECS, CODEC_ID as ${target.alias}_CODEC_ID } from './${target.module.replace(/\.ts$/,'.js')}';`));assert(registry.includes(`{ codecs: ${target.alias}_CODECS, codecId: ${target.alias}_CODEC_ID }`));return {codecId:id[1],platform,arch,inputs:[registryPath,sourcePath].map(path=>({path,...identity(join(root,path))}))};}
