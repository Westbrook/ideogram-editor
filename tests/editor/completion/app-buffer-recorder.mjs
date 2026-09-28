import {Server} from 'node:http';
import {createHash} from 'node:crypto';

const sha = value => createHash('sha256').update(value).digest('hex');
const errorRecord = e => ({name:e?.name??null,message:e?.message??String(e),stack:e?.stack??null});
const copy = v => v===undefined?{unexposed:true}:structuredClone(v);
export function sessionCookies(headers) {
  const raw=headers['set-cookie'];return (Array.isArray(raw)?raw:raw?[raw]:[]).map(value=>{
    const parts=String(value).split(';').map(x=>x.trim()),[name,...rest]=parts[0].split('=');
    return {name,valueSHA256:sha(rest.join('=')),httpOnly:parts.includes('HttpOnly'),sameSite:parts.find(x=>x.startsWith('SameSite='))?.slice(9)??null,path:parts.find(x=>x.startsWith('Path='))?.slice(5)??null,domain:parts.find(x=>/^Domain=/i.test(x))??null};
  });
}
// Observe original public objects and header APIs. Never read, replace or wrap the body/end.
export function installServerRecorder({sink,now=()=>Date.now(),prototype=Server.prototype}) {
  const prior=prototype.emit, failures=[], rows=[], servers=new WeakMap(), requests=new WeakMap(), responses=new WeakMap();
  let nextServer=0,nextRequest=0,sequence=0;
  const state={attempted:true,installed:false,active:true,requests:0,servers:0,failures,installedAt:now(),pid:process.pid};
  const log=(kind,value={})=>{const row={sequence:++sequence,kind,at:now(),pid:process.pid,...value};rows.push(row);try{sink(row);}catch(error){failures.push({at:now(),sequence:row.sequence,kind,error:errorRecord(error)});}return row;};
  const observe=fn=>{try{return fn();}catch(error){failures.push({at:now(),kind:'metadata-observation',error:errorRecord(error)});}};
  function wrapped(event,...args) {
    if(event==='request') {
      try {
        const [request,response]=args;
        if(requests.has(request)||responses.has(response))throw Error('Duplicate original server request/response object');
        if(!servers.has(this)){servers.set(this,++nextServer);state.servers=nextServer;}
        const id=++nextRequest,serverId=servers.get(this);requests.set(request,id);responses.set(response,id);state.requests=nextRequest;
        const info={id,serverId,method:request.method,url:request.url,path:new URL(request.url,'http://127.0.0.1').pathname,requestObject:true,responseObject:true,responseRequestSame:response.req===request};
        log('request',{...info,headers:copy(request.headers),rawHeaders:[...request.rawHeaders],httpVersion:request.httpVersion,localAddress:request.socket.localAddress,localPort:request.socket.localPort,remoteAddress:request.socket.remoteAddress,remotePort:request.socket.remotePort});
        for(const name of ['setHeader','appendHeader','removeHeader','writeHead']) {
          const original=response[name];if(typeof original!=='function')throw Error('Missing documented response method '+name);
          response[name]=function(...originalArgs){
            const same=this===response&&responses.get(this)===id;
            observe(()=>log('header-call',{...info,name,sameResponseObject:same,args:copy(originalArgs),statusBefore:this.statusCode}));
            let returned;
            try{returned=Reflect.apply(original,this,originalArgs);}
            catch(error){observe(()=>log('header-throw',{...info,name,sameResponseObject:same,error:errorRecord(error)}));throw error;}
            observe(()=>log('header-return',{...info,name,sameResponseObject:same,returnIsResponse:returned===response,returnType:typeof returned,status:this.statusCode,headers:copy(this.getHeaders()),headersSent:this.headersSent}));
            return returned;
          };
        }
        response.once('finish',()=>observe(()=>log('response',{...info,status:response.statusCode,headers:copy(response.getHeaders()),headerNames:response.getHeaderNames(),writableFinished:response.writableFinished,headersSent:response.headersSent,cookies:sessionCookies(response.getHeaders()),originalObjects:requests.get(request)===id&&responses.get(response)===id})));
        response.once('close',()=>observe(()=>log('response-close',{...info,status:response.statusCode,headers:copy(response.getHeaders()),writableFinished:response.writableFinished,destroyed:response.destroyed,originalObjects:requests.get(request)===id&&responses.get(response)===id})));
      }catch(error){failures.push({at:now(),kind:'observation-install',error:errorRecord(error)});}
    }
    return Reflect.apply(prior,this,[event,...args]);
  }
  prototype.emit=wrapped;state.installed=prototype.emit===wrapped;
  log('recorder-install',{installed:state.installed,metadataOnly:true,preserveOriginalEmit:true,bodyMethodsUnwrapped:true});
  return {state,rows,assertHealthy(){if(!state.installed||failures.length)throw Error('Server recorder incomplete: '+JSON.stringify(failures));},uninstall(){if(prototype.emit!==wrapped)throw Error('Recorder installation ownership changed');prototype.emit=prior;state.active=false;log('recorder-uninstall',{restoredOriginal:true});}};
}
