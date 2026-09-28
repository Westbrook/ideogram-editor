// Passive main-page metadata only. No worker-realm code or payload copies.
export function installCompletionObserver({key}) {
  if(!['http:','https:'].includes(location.protocol))return;
  const Native=globalThis.Worker, post=Native.prototype.postMessage, terminate=Native.prototype.terminate;
  const workers=new WeakMap(), rows=[], errors=[]; let sequence=0,nextWorker=0,action=null;
  const epoch=crypto.randomUUID();
  const token=v=>v?Object.fromEntries(['documentId','documentRevision','layerId','layerVersion','sessionId','generation'].map(k=>[k,v[k]])):null;
  const record=(kind,data={})=>{try{rows.push({sequence:++sequence,epoch,kind,actionId:action?.id??null,...data});}catch(e){errors.push(String(e));}};
  const observe=fn=>{try{fn();}catch(e){errors.push(String(e));}};
  const summary=v=>({ready:v?.ready===true,ok:v?.ok??null,code:v?.code??null,fatal:v?.fatal??null,token:token(v?.value?.token),rasterHash:v?.value?.rasterHash??null,rgbaBytes:v?.value?.rgba?.size??null,width:v?.value?.width??null,height:v?.value?.height??null});
  Native.prototype.postMessage=function(...args){const w=workers.get(this);if(w)observe(()=>record('post',{workerId:w.id,workerAction:w.actionId,token:token(args[0]?.token),text:args[0]?.text}));try{const v=Reflect.apply(post,this,args);if(w)record('post-return',{workerId:w.id});return v;}catch(e){if(w)record('post-error',{workerId:w.id,error:String(e)});throw e;}};
  Native.prototype.terminate=function(...args){const w=workers.get(this);if(w)record('terminate',{workerId:w.id});try{const v=Reflect.apply(terminate,this,args);if(w)record('terminate-return',{workerId:w.id});return v;}catch(e){if(w)record('terminate-error',{workerId:w.id,error:String(e)});throw e;}};
  const Wrapped=new Proxy(Native,{construct(target,args,newTarget){const value=Reflect.construct(target,args,newTarget===Wrapped?target:newTarget);observe(()=>{const w={id:++nextWorker,actionId:action?.id??null};workers.set(value,w);record('created',{workerId:w.id,url:String(args[0]),type:args[1]?.type??null,name:args[1]?.name??null});value.addEventListener('message',e=>observe(()=>record('message',{workerId:w.id,workerAction:w.actionId,...summary(e.data)})));value.addEventListener('error',e=>record('worker-error',{workerId:w.id,message:e.message}));});return value;}});
  globalThis.Worker=Wrapped;
  document.addEventListener('input',event=>observe(()=>{const el=event.target;if(el?.id!=='native-text-content')return;const region=el.closest('#native-text-editor');record('native-input',{trusted:event.isTrusted,value:el.value,draftId:region?.getAttribute('data-session'),revision:region?.getAttribute('data-revision'),connected:el.isConnected,editable:!el.readOnly&&!el.disabled});}),true);
  Object.defineProperty(globalThis,key,{value:{begin(value){if(action)throw Error('Operation already open');action={...value};record('action-begin',{action:{...value}});},mark(kind,value){if(!action)throw Error('No owned action');record(kind,value);},snapshot(){return {epoch,rows,errors};},end(value){if(!action)throw Error('No owned action');record('action-end',value);action=null;}},configurable:false});
  record('installed');
}
