import {createHash} from 'node:crypto';
import {crc32} from 'node:zlib';
export const sha=b=>createHash('sha256').update(b).digest('hex');
export const canonical=x=>x===null||typeof x!=='object'?JSON.stringify(x):Array.isArray(x)?'['+x.map(canonical).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
export function unpack(b){
 const e=b.length-22;let count=b.readUInt16LE(e+10),at=b.readUInt32LE(e+16);
 if(count===65535||at===0xffffffff){const z=Number(b.readBigUInt64LE(e-12));count=Number(b.readBigUInt64LE(z+32));at=Number(b.readBigUInt64LE(z+48));}
 const out=new Map();for(let i=0;i<count;i++){
  const len=b.readUInt16LE(at+28),extra=b.readUInt16LE(at+30),comment=b.readUInt16LE(at+32),name=b.subarray(at+46,at+46+len).toString();
  let size=b.readUInt32LE(at+24),compressed=b.readUInt32LE(at+20),offset=b.readUInt32LE(at+42),x=at+46+len;
  if(extra){if(b.readUInt16LE(x)!==1)throw Error('Unexpected source extra');x+=4;if(size===0xffffffff){size=Number(b.readBigUInt64LE(x));x+=8;}if(compressed===0xffffffff)x+=8;if(offset===0xffffffff)offset=Number(b.readBigUInt64LE(x));}
  const start=offset+30+b.readUInt16LE(offset+26)+b.readUInt16LE(offset+28),data=Buffer.from(b.subarray(start,start+size));
  if(crc32(data)!==b.readUInt32LE(at+16))throw Error('CRC mismatch');if(out.has(name))throw Error('Duplicate');out.set(name,data);at+=46+len+extra+comment;
 }return out;
}
export function pack(entries){
 const local=[],central=[];let offset=0;
 for(const [name,bytes] of entries){const n=Buffer.from(name),l=Buffer.alloc(30),c=Buffer.alloc(46),crc=crc32(bytes);
  l.writeUInt32LE(0x04034b50);l.writeUInt16LE(20,4);l.writeUInt32LE(crc,14);l.writeUInt32LE(bytes.length,18);l.writeUInt32LE(bytes.length,22);l.writeUInt16LE(n.length,26);
  c.writeUInt32LE(0x02014b50);c.writeUInt16LE(0x314,4);c.writeUInt16LE(20,6);c.writeUInt32LE(crc,16);c.writeUInt32LE(bytes.length,20);c.writeUInt32LE(bytes.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(0x81800000,38);c.writeUInt32LE(offset,42);
  local.push(l,n,bytes);central.push(c,n);offset+=30+n.length+bytes.length;
 }const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.size,8);end.writeUInt16LE(entries.size,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,directory,end]);
}
export function replaceEvents(entries,transform){const m=JSON.parse(entries.get('manifest.json'));let removed=[];for(const s of m.segments.filter(s=>s.kind==='events')){
 const old=entries.get(s.path).toString().trimEnd().split('\n').map(JSON.parse),next=transform(old);removed.push(...old.filter(x=>!next.includes(x)));const bytes=Buffer.from(next.map(canonical).join('\n')+'\n');entries.set(s.path,bytes);s.bytes=String(bytes.length);s.recordCount=String(next.length);s.sha256=sha(bytes);
 }entries.set('manifest.json',Buffer.from(canonical(m)));return removed;}
