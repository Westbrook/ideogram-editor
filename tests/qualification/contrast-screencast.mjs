import {createHash} from 'node:crypto';

// Test-side sole public screencast owner. Trace/video clients internal to the
// runner may coexist; their cached frame never grants this capture admission.
const owners=new WeakSet();
function jpegDimensions(data){
  if(data.length<4||data[0]!==255||data[1]!==216||data.at(-2)!==255||data.at(-1)!==217)return null;
  let offset=2;
  while(offset+4<=data.length){
    if(data[offset++]!==255)return null;
    while(data[offset]===255)offset++;
    const marker=data[offset++];
    if(marker===0||marker===216||marker===217||marker===218||marker===1||(marker>=208&&marker<=215))return null;
    if(offset+2>data.length)return null;
    const length=data.readUInt16BE(offset);
    if(length<2||offset+length>data.length)return null;
    if(marker===192||marker===194){
      if(length<8||data[offset+2]!==8)return null;
      const height=data.readUInt16BE(offset+3),width=data.readUInt16BE(offset+5),components=data[offset+7];
      return width>0&&height>0&&[1,3,4].includes(components)&&length===8+3*components?{width,height}:null;
    }
    offset+=length;
  }
  return null;
}

/** One bounded JPEG supplement, never pixel equality or physical presentation.
 * The caller owns the page's public screencast client; no other public start()
 * may overlap. start/stop have no public abort API: the frame deadline is not a
 * protocol-operation timeout, and the existing outer test timeout still applies.
 */
export async function captureWebKitContrast(page,{width,height,maximumBytes=4*1024*1024,maximumWaitMs=5000}={}){
  const metadata={kind:'webkit-supplemental-contrast-screencast-1',method:'playwright-public-screencast',codec:'JPEG',mimeType:'image/jpeg',requestedQuality:100,
    status:'unknown',requestedSize:{width,height},fullPage:false,clip:null,
    maximumBytes,maximumFrames:32,maximumWaitMs,startedWallMs:Date.now(),startedMonotonicMs:performance.now(),finishedWallMs:null,finishedMonotonicMs:null,
    frames:[],selected:null,start:'not-attempted',stop:'not-attempted',errors:[],
    qualityAuthority:'Requested quality only; a pre-existing internal trace/video client may own actual encoder settings, which the public frame does not expose.',
    timestampAuthority:'Public frame timestamp, converted by Playwright to wall time; not an independent physical clock or atomic DOM/frame join.',
    frameIdentity:'Selected callback ordinal plus exact JPEG bytes/hash; the public callback exposes no native frame ID.',
    bounds:'At most one admitted frame retained, at most32 scalar frame records; rejected buffers are not copied or retained. Header dimensions are not a full JPEG decode.'};
  const result={data:null,metadata,stopFailed:false};
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<2||height<2||width%2||height%2||
     !Number.isSafeInteger(maximumBytes)||maximumBytes<4||maximumBytes>4*1024*1024||
     !Number.isFinite(maximumWaitMs)||maximumWaitMs<=0||maximumWaitMs>5000){metadata.status='unknown-capture-bounds';return result;}
  if(owners.has(page)){metadata.status='unknown-existing-capture-owner';return result;}
  owners.add(page);
  let settled=false,resolveFrame;
  const gotFrame=new Promise(resolve=>{resolveFrame=resolve;});
  const settle=()=>{if(!settled){settled=true;resolveFrame();}};
  const timer=setTimeout(()=>{if(!settled){metadata.status='unknown-frame-deadline';settle();}},maximumWaitMs);
  try{
    metadata.start='attempted';
    await page.screencast.start({size:{width,height},quality:100,onFrame:frame=>{
      if(settled)return;
      try{
        const receivedWallMs=Date.now(),receivedMonotonicMs=performance.now(),ordinal=metadata.frames.length+1;
        const bytes=Buffer.isBuffer(frame.data)?frame.data.length:null;
        const dimensions=bytes!==null&&bytes<=maximumBytes?jpegDimensions(frame.data):null;
        const reason=receivedMonotonicMs-metadata.startedMonotonicMs>maximumWaitMs?'frame-deadline':bytes===null?'invalid-buffer':bytes>maximumBytes?'byte-cap':
          !Number.isFinite(frame.timestamp)?'invalid-timestamp':frame.timestamp<metadata.startedWallMs?'cached-frame':frame.timestamp>receivedWallMs?'future-timestamp':
          frame.viewportWidth!==width||frame.viewportHeight!==height?'viewport-mismatch':
          !dimensions?'invalid-jpeg-header':dimensions.width!==width||dimensions.height!==height?'encoded-size-mismatch':null;
        const row={ordinal,timestamp:Number.isFinite(frame.timestamp)?frame.timestamp:null,receivedWallMs,receivedMonotonicMs,
          viewportWidth:Number.isFinite(frame.viewportWidth)?frame.viewportWidth:null,viewportHeight:Number.isFinite(frame.viewportHeight)?frame.viewportHeight:null,
          bytes,encodedSize:dimensions,reason};
        metadata.frames.push(row);
        if(!reason){
          result.data=frame.data;metadata.selected={...row,sha256:createHash('sha256').update(frame.data).digest('hex'),
            encodedPixelsPerCSSPixel:{x:dimensions.width/width,y:dimensions.height/height}};
          metadata.status='captured';settle();
        }else if(reason==='frame-deadline'||reason==='byte-cap'||ordinal===metadata.maximumFrames){metadata.status=reason==='frame-deadline'?'unknown-frame-deadline':reason==='byte-cap'?'unknown-image-byte-cap':'unknown-frame-cap';settle();}
      }catch{metadata.errors.push('frame-callback-failed');metadata.status='unknown-frame-callback';settle();}
    }});
    metadata.start='fulfilled';
    await gotFrame;
  }catch{metadata.start='rejected';metadata.errors.push('start-failed');metadata.status='unknown-start-failed';settle();}
  finally{
    clearTimeout(timer);settle();
    // A rejected start may already have installed its public callback. In this
    // sole-owner scope, await cleanup even after partial start; never silently
    // certify a frame after failed stop or reuse this page's failed owner.
    metadata.stop='attempted';
    try{await page.screencast.stop();metadata.stop='fulfilled';owners.delete(page);}
    catch{metadata.stop='rejected';metadata.errors.push('stop-failed');metadata.status='unknown-stop-failed';result.stopFailed=true;}
    metadata.finishedWallMs=Date.now();metadata.finishedMonotonicMs=performance.now();
    if(metadata.status!=='captured')result.data=null;
  }
  return result;
}
