// Docker Desktop may omit this exact image metadata label from container
// inspection even when create explicitly requests it. Preserve the full request
// and normalize only this observed interface difference when comparing labels.
import {isDeepStrictEqual} from 'node:util';

const DESKTOP_METADATA='desktop.docker.io/ports.scheme';
const OWNERS=new Set(['org.ideogram.rollback-run','org.ideogram.rollback-attempt']);
const require=(value,code)=>{if(!value)throw Error(code);};
function boundedMap(value) {
  require(value===null || (value && typeof value==='object'&&!Array.isArray(value)), 'IMAGE_LABEL_MAP');
  const entries=Object.entries(value??{});
  require(entries.length<=64 && entries.every(([key,item])=>typeof item==='string'&&key.length>0&&Buffer.byteLength(key)<=256&&!/[=\0\r\n]/.test(key)&&Buffer.byteLength(item)<=4096&&!item.includes('\0')), 'IMAGE_LABEL_BOUND');
  const copied=Object.fromEntries(entries);
  require(Buffer.byteLength(JSON.stringify(copied))<=65536,'IMAGE_LABEL_TOTAL_BOUND');
  return copied;
}
export function requestedImageLabels(imageLabels,overrides) {
  const image=boundedMap(imageLabels),owners=boundedMap(overrides);
  require(!Object.hasOwn(image,DESKTOP_METADATA)||image[DESKTOP_METADATA]==='v2','IMAGE_METADATA_VALUE');
  require(Object.keys(owners).every(key=>OWNERS.has(key)), 'IMAGE_LABEL_OWNER_OVERRIDE');
  return boundedMap({...image,...owners});
}
export function projectedContainerLabels(imageLabels,overrides) {
  const expected=requestedImageLabels(imageLabels,overrides);
  if(Object.hasOwn(expected,DESKTOP_METADATA))delete expected[DESKTOP_METADATA];
  return expected;
}
export function containerImageLabelsMatch(actualLabels,imageLabels,overrides) {
  const expected=requestedImageLabels(imageLabels,overrides),actual=boundedMap(actualLabels);
  if(Object.hasOwn(expected,DESKTOP_METADATA)) {
    // The selected image declared exactly v2. A different observed value is a
    // mismatch, while absence and the unchanged value are both supported.
    if(Object.hasOwn(actual,DESKTOP_METADATA)&&actual[DESKTOP_METADATA]!=='v2')return false;
    delete expected[DESKTOP_METADATA];delete actual[DESKTOP_METADATA];
  }
  return isDeepStrictEqual(actual,expected);
}
export function imageLabelArgs(labels) {
  return Object.entries(boundedMap(labels)).sort(([a],[b])=>a<b?-1:a>b?1:0).flatMap(([key,value])=>['--label',key+'='+value]);
}
