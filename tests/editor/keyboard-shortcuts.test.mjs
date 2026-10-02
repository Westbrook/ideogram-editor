import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {transformWithOxc} from 'vite';
const root=process.env.EDITOR_SHORTCUT_ROOT??'.',data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
async function source(path){try{return await readFile(resolve(root,path),'utf8');}catch(error){if(error.code!=='ENOENT'||root==='.')throw error;return readFile(path,'utf8');}}
async function compile(path){const original=await source(path);return (await transformWithOxc(original,path)).code+'\n//# sourceURL=ideogram-keyboard/'+path+'?sha256='+createHash('sha256').update(original).digest('hex')+'\n';}
const helperURL=data(await compile('src/ui/keyboard-scope.ts')),adapterURL=data(await compile('src/ui/adapters.ts'));
const scope=await import(helperURL),{ControlAdapter}=await import(adapterURL);
// The actual compiled shell methods execute. Only DOM boundaries, editor
// transport and browser-only field construction are controlled in this fixture.
const compiled=await compile('src/ui/shell.ts'),shellClass=compiled.slice(compiled.indexOf('class EditorShell'),compiled.lastIndexOf('scope.register('));
const shellModule=await import(data(`import {shortcutPath,shortcutFocus,shortcutActivation,shortcutModalConflict} from ${JSON.stringify(helperURL)};class LitElement{};const connection={transport(){}};class CanvasView{constructor(canvas,transport,hooks){this.hooks=hooks;this.ownership={contextLost:false,contextRestoring:false,suspended:false};}}let editor;export function bind(value){editor=value;} ${shellClass} export {EditorShell};`));
class Element{
 constructor(tag='DIV',parent=null){Object.assign(this,{tagName:tag,parentElement:parent,isConnected:true,inert:false,hidden:false,isContentEditable:false,attrs:{},ownerDocument:parent?.ownerDocument??{activeElement:null},id:'',shadowRoot:null});}
 getAttribute(name){return this.attrs[name]??null;}
 getRootNode(){return this.root??this.ownerDocument;}
 matches(selectors){return selectors.split(',').some(s=>{if(s==='[contenteditable]:not([contenteditable="false"])')return this.attrs.contenteditable!==undefined&&this.attrs.contenteditable!=='false';const role=s.match(/^\[role="([^" ]+)"\]$/);if(role)return this.attrs.role===role[1];if(s==='a[href]')return this.tagName==='A'&&'href'in this.attrs;return s.toUpperCase()===this.tagName;});}
}
Object.setPrototypeOf(shellModule.EditorShell.prototype,Element.prototype);
const turn=()=>new Promise(resolve=>setTimeout(resolve,8));
function fixture(){
 const prior=globalThis.HTMLElement;globalThis.HTMLElement=Element;
 const shell=Object.create(shellModule.EditorShell.prototype);Object.assign(shell,new Element('IE-SHELL'));
 const canvas=new Element('SECTION',shell),tools=new Element('ASIDE',shell),tree=new Element('EN-TREE',shell),treeItem=new Element('DIV',tree),modals=[],calls=[],failures=[];tree.selectedKeys=['layer'];treeItem.attrs={role:'treeitem','aria-selected':'true'};
 const document={id:'document',revision:'4'},layer={id:'layer',version:'2',locked:false,kind:'image'},identity={};
 const editor={navigationViewportUnavailable(){},view:{ready:true,busy:false,document,selected:['layer'],image:{layers:[layer]}},documentEpoch:1,sessionId:'session',session:{identity:()=>identity},fail:error=>failures.push(error),preferences:async value=>calls.push(['preferences',value]),run:async(label,work)=>{calls.push(['run',label]);await work();}};
 shellModule.bind(editor);
 Object.assign(shell,{canvas:{ownership:{suspended:false,contextLost:false,contextRestoring:false}},reviewedCanvasPreview:null,composition:false,textEditing:{active:false,composing:false},semantic:{dragging:false},authoring:{drawing:false,choose:name=>calls.push(['choose',name])},adapter:new ControlAdapter(),singleKeyShortcuts:true,tool:'Move',temporaryPan:null,gesture:null,pan:{x:10,y:20},zoom:1,fieldsOwner:{value:{document,layer,draftId:'fields',dirty:false}},requestUpdate(){},draw(){calls.push(['draw']);},togglePane:async(...args)=>calls.push(['pane',...args]),showPanel:name=>calls.push(['panel',name]),querySelector:selector=>({'#canvas':canvas,'.tool-rail':tools,'#layer-tree':tree}[selector]??null),querySelectorAll:()=>modals,inspectorLayerAction:async(...args)=>calls.push(['delete',...args])});
 function event(key,target=canvas,extra={}){shell.ownerDocument.activeElement=target;let at=target,path=[];while(at){path.push(at);at=at.parentElement??at.root?.host??null;}return {key,code:key===' '?'Space':'',keyCode:0,defaultPrevented:false,repeat:false,isComposing:false,metaKey:false,ctrlKey:false,altKey:false,shiftKey:false,currentTarget:shell,target,timeStamp:1,composedPath:()=>path,expire(){path=[];},preventDefault(){this.defaultPrevented=true;},...extra};}
 return {shell,canvas,tools,tree,treeItem,editor,modals,calls,failures,event,restore(){globalThis.HTMLElement=prior;}};
}
test('actual shell maps all specified canvas and toolbar tool letters through chooseTool',async()=>{
 const f=fixture();try{for(const [key,name]of Object.entries({v:'Move',m:'Select',b:'Mask',h:'Pan',i:'Sample',c:'Crop'})){const event=f.event(key,key==='b'?f.tools:f.canvas);f.shell.handleShortcut(event);event.expire();await turn();assert.equal(f.shell.tool,name);}assert.deepEqual(f.calls.filter(v=>v[0]==='choose').map(v=>v[1]),['Move','Select','Mask','Pan','Sample','Crop']);assert(f.calls.some(v=>v[0]==='panel'&&v[1]==='bounds'));assert.deepEqual(f.failures,[]);}finally{f.restore();}
});
test('default prevention, repeat, IME, editable shadow focus and inactive focus never select a tool',async()=>{
 const f=fixture();try{for(const extra of [{defaultPrevented:true},{repeat:true},{isComposing:true},{keyCode:229},{altKey:true},{ctrlKey:true,metaKey:true}])f.shell.handleShortcut(f.event('b',f.canvas,extra));
 for(const tag of ['INPUT','TEXTAREA','SELECT','EN-NUMBER-FIELD']){const input=new Element(tag,f.canvas);f.shell.handleShortcut(f.event('b',input));}
 const editable=new Element('DIV',f.canvas);editable.isContentEditable=true;f.shell.handleShortcut(f.event('b',editable));
 const host=new Element('EN-TEXTAREA',f.canvas),native=new Element('TEXTAREA');native.ownerDocument=f.shell.ownerDocument;native.root={host};host.shadowRoot={activeElement:native};const event=f.event('b',native);f.shell.ownerDocument.activeElement=host;f.shell.handleShortcut(event);
 const stale=f.event('b');f.shell.ownerDocument.activeElement=f.tree;f.shell.handleShortcut(stale);await turn();assert.equal(f.calls.length,0);}finally{f.restore();}
});
test('late veto and document, focus or modal changes defeat deferred tool actions',async()=>{
 const f=fixture();try{for(const change of [event=>event.preventDefault(),()=>{f.editor.documentEpoch++;},()=>{f.shell.ownerDocument.activeElement=f.tree;},()=>{const modal=new Element('EN-DIALOG',f.shell);modal.open=true;f.modals.push(modal);},()=>{f.canvas.parentElement=f.tree;}]){const event=f.event('b');f.shell.handleShortcut(event);change(event);event.expire();await turn();f.modals.length=0;f.canvas.parentElement=f.shell;}assert.equal(f.calls.length,0);}finally{f.restore();}
});
test('Space temporarily owns pan without changing the selected tool and cancellation restores the held gesture',()=>{
 const f=fixture();try{const event=f.event(' ');f.shell.handleShortcut(event);assert.equal(event.defaultPrevented,true);assert.equal(f.shell.temporaryPanCurrent(),true);assert.equal(f.shell.tool,'Move');f.shell.gesture={id:7,x:0,y:0,oldX:10,oldY:20,temporary:true};f.shell.pan={x:40,y:50};f.shell.endTemporaryPan();assert.deepEqual(f.shell.pan,{x:10,y:20});assert.equal(f.shell.gesture,null);assert.equal(f.shell.temporaryPan,null);assert.equal(f.shell.tool,'Move');assert(!f.calls.some(v=>v[0]==='preferences'));}finally{f.restore();}
});
test('Space never overrides native button activation, text space, disabled keys, active gesture or native text',()=>{
 const f=fixture();try{for(const target of [new Element('BUTTON',f.canvas),new Element('EN-BUTTON',f.canvas),new Element('INPUT',f.canvas)])f.shell.handleShortcut(f.event(' ',target));f.shell.singleKeyShortcuts=false;f.shell.handleShortcut(f.event(' '));f.shell.singleKeyShortcuts=true;f.shell.authoring.drawing=true;f.shell.handleShortcut(f.event(' '));f.shell.authoring.drawing=false;f.shell.textEditing.active=true;f.shell.handleShortcut(f.event(' '));assert.equal(f.shell.temporaryPan,null);}finally{f.restore();}
});
test('temporary pan loses authority on document, session, modal and canvas-loss transitions',()=>{
 const f=fixture();try{for(const change of [()=>{f.editor.documentEpoch++;},()=>{f.editor.view.document={id:'other',revision:'1'};},()=>{f.editor.sessionId+='x';},()=>{const modal=new Element('EN-DIALOG',f.shell);modal.open=true;f.modals.push(modal);},()=>{f.shell.canvas.ownership.contextLost=true;}]){f.shell.handleShortcut(f.event(' '));assert.equal(f.shell.temporaryPanCurrent(),true);change();assert.equal(f.shell.temporaryPanCurrent(),false);f.shell.endTemporaryPan();f.modals.length=0;f.shell.canvas.ownership.contextLost=false;}}finally{f.restore();}
});
test('Delete uses the existing version-fenced layer action only for current single selected canvas or list ownership',async()=>{
 const f=fixture();try{for(const target of [f.canvas,f.treeItem]){const event=f.event('Delete',target);f.shell.handleShortcut(event);event.expire();await turn();}assert.deepEqual(f.calls.filter(v=>v[0]==='delete'),[['delete','delete','fields'],['delete','delete','fields']]);}finally{f.restore();}
});
test('Delete refuses ambiguous, locked, dirty, stale, input, button and unrelated focus before dispatch',async()=>{
 const f=fixture();try{for(const target of [f.tools,f.tree,new Element('INPUT',f.canvas),new Element('BUTTON',f.canvas)])f.shell.handleShortcut(f.event('Delete',target));const fields=f.shell.fieldsOwner.value;
 for(const change of [()=>{f.editor.view.selected=[];},()=>{f.editor.view.selected=['layer','other'];},()=>{fields.layer.locked=true;},()=>{fields.dirty=true;},()=>{fields.document={id:'document',revision:'3'};},()=>{f.editor.view.busy=true;}]){change();f.shell.handleShortcut(f.event('Delete'));f.editor.view.selected=['layer'];fields.layer.locked=false;fields.dirty=false;fields.document=f.editor.view.document;f.editor.view.busy=false;}await turn();assert(!f.calls.some(v=>v[0]==='delete'||v[0]==='run'));}finally{f.restore();}
});
test('Delete rechecks final dispatch veto, selection, revision and layer version without reading retired field ownership',async()=>{
 const f=fixture();try{for(const change of [event=>event.preventDefault(),()=>{f.editor.view.selected=['other'];},()=>{f.editor.view.document={id:'document',revision:'5'};},()=>{f.shell.fieldsOwner={value:{...f.shell.fieldsOwner.value,layer:{...f.shell.fieldsOwner.value.layer,version:'3'}}};}]){const event=f.event('Delete');f.shell.handleShortcut(event);change(event);event.expire();await turn();f.editor.view.selected=['layer'];f.shell.fieldsOwner.value.document=f.editor.view.document;}assert(!f.calls.some(v=>v[0]==='delete'||v[0]==='run'));}finally{f.restore();}
});
test('helper permits only the explicitly owned request drawer and follows actual shadow focus ancestry',()=>{
 const f=fixture();try{const drawer=new Element('EN-DRAWER',f.shell);drawer.id='request-drawer';drawer.open=true;const region=new Element('DIV',drawer),button=new Element('EN-BUTTON',region),native=new Element('BUTTON');native.ownerDocument=f.shell.ownerDocument;native.root={host:button};button.shadowRoot={activeElement:native};const event=f.event('Enter',native);f.shell.ownerDocument.activeElement=button;const path=scope.shortcutPath(event,region);assert(path);assert.equal(scope.shortcutActivation(path),true);f.modals.push(drawer);assert.equal(scope.shortcutModalConflict(f.shell,path,'request-drawer'),false);assert.equal(scope.shortcutModalConflict(f.shell,path),true);drawer.id='other';assert.equal(scope.shortcutModalConflict(f.shell,path,'request-drawer'),true);native.isConnected=false;assert.equal(scope.shortcutFocus(path,region),false);}finally{f.restore();}
});

test('Delete refuses a focused unselected tree row even while a different layer remains selected',async()=>{const f=fixture();try{f.treeItem.attrs['aria-selected']='false';f.shell.handleShortcut(f.event('Delete',f.treeItem));await turn();assert.equal(f.calls.length,0);f.treeItem.attrs['aria-selected']='true';const event=f.event('Delete',f.treeItem);f.shell.handleShortcut(event);f.tree.selectedKeys=['other'];event.expire();await turn();assert.equal(f.calls.length,0);}finally{f.restore();}});

test('actual canvas context-loss callback rolls back temporary pan before discarding gesture identity',()=>{const f=fixture();try{const element={hasPointerCapture:()=>true,releasePointerCapture:id=>f.calls.push(['release-pointer',id])};f.shell.createCanvasView(element);f.shell.authoring.cancelGesture=()=>f.calls.push(['cancel-authoring']);f.shell.semantic.cancelDrag=()=>f.calls.push(['cancel-semantic']);f.shell.handleShortcut(f.event(' '));f.shell.gesture={id:9,x:0,y:0,oldX:10,oldY:20,temporary:true};f.shell.pan={x:40,y:50};f.shell.canvas.ownership.contextLost=true;f.shell.canvas.hooks.changed();assert.equal(f.shell.temporaryPan,null);assert.equal(f.shell.gesture,null);assert.deepEqual(f.shell.pan,{x:10,y:20});assert(f.calls.some(v=>v[0]==='release-pointer'&&v[1]===9));}finally{f.restore();}});

test('existing shifted H remains a Pan shortcut while disabled one-key preference still suppresses it',async()=>{const f=fixture();try{f.shell.handleShortcut(f.event('H',f.canvas,{shiftKey:true}));await turn();assert.equal(f.shell.tool,'Pan');f.shell.tool='Move';f.shell.singleKeyShortcuts=false;f.shell.handleShortcut(f.event('H',f.canvas,{shiftKey:true}));await turn();assert.equal(f.shell.tool,'Move');}finally{f.restore();}});

test('Escape restores a held temporary pan before releasing its actual pointer capture',()=>{const f=fixture();try{f.shell.canvasElement={hasPointerCapture:()=>true,releasePointerCapture:id=>f.calls.push(['release-pointer',id])};f.shell.handleShortcut(f.event(' '));f.shell.gesture={id:11,x:0,y:0,oldX:10,oldY:20,temporary:true};f.shell.pan={x:40,y:50};f.shell.handleShortcut(f.event('Escape'));assert.equal(f.shell.temporaryPan,null);assert.equal(f.shell.gesture,null);assert.deepEqual(f.shell.pan,{x:10,y:20});assert(f.calls.some(v=>v[0]==='release-pointer'&&v[1]===11));assert(!f.calls.some(v=>v[0]==='preferences'));}finally{f.restore();}});
