import {html,nothing,type LitElement} from 'lit';
import {repeat} from 'lit/directives/repeat.js';
import type {EnDialog} from '@en-reve/elements/dialog.js';
import type {EditorClient} from '../state/editor-client.js';
import type {OwnedModel} from '../observability/model-memory.js';
import {ControlAdapter} from './adapters.js';
import {DialogOwnership} from './dialog-ownership.js';

export type ShellCommand={id:string;label:string;description:string;disabledReason:string;run:()=>void|Promise<void>};
type SearchRow=Omit<ShellCommand,'run'>;
/** Search is navigation to existing commands; matching never executes work. */
export class CommandSearch{
  #controls=new ControlAdapter();#commands:()=>readonly ShellCommand[];private lease:OwnedModel<{query:string;message:string}>|null=null;private rendered:OwnedModel<SearchRow[]>|null=null;private query='';private message='';private opened=false;private composing=false;private epoch=0;private disposed=false;
  private opener:HTMLElement|null=null;private pending=new Set<Promise<void>>();private memory:DialogOwnership;private identities=new WeakMap<object,number>();private identitySequence=0;
  constructor(private host:LitElement,private editor:EditorClient,commands:()=>readonly ShellCommand[],private panels:()=>Promise<void>){this.#commands=commands;this.memory=new DialogOwnership(host,'command-search-ui');}
  get lifecycle(){return {...this.memory.lifecycle,pending:this.pending.size};}
  private changed(){this.host.requestUpdate();}
  private token(value:object|null){if(!value)return 0;let token=this.identities.get(value);if(token===undefined){if(this.identitySequence>=Number.MAX_SAFE_INTEGER)throw Error('COMMAND_SEARCH_IDENTITY_LIMIT');token=++this.identitySequence;this.identities.set(value,token);}return token;}
  private owner(){return {identity:this.editor.session.identity(),session:this.editor.sessionId,document:this.token(this.editor.view.document),selected:this.token(this.editor.view.selected)};}
  private owns(owner:ReturnType<CommandSearch['owner']>){return !this.disposed&&owner.identity===this.editor.session.identity()&&owner.session===this.editor.sessionId&&owner.document===this.token(this.editor.view.document)&&owner.selected===this.token(this.editor.view.selected);}
  private current(epoch:number){return !this.disposed&&this.opened&&epoch===this.epoch;}
  private publish(query:string,message:string){const next=this.memory.create(4096,()=>({query,message})),prior=this.lease;this.lease=next;this.query=query;this.message=message;if(prior)void this.memory.retire(prior).catch(error=>this.editor.fail(error));}
  #action(event:Event,epoch:number,work:()=>void){if(!this.current(epoch)){event.preventDefault();return;}let release:()=>void;try{release=this.memory.action([this.lease,this.rendered],{epoch});}catch(error){event.preventDefault();this.editor.fail(error);return;}this.#controls.action(event,()=>{try{if(this.current(epoch))work();}catch(error){this.editor.fail(error);}});setTimeout(release,0);}
  #items(){
    const commands=this.#commands();if(commands.length>32)throw Error('COMMAND_SEARCH_LIMIT');
    const seen=new Set<string>();for(const command of commands){if(!/^[a-z][a-z0-9-]{0,63}$/.test(command.id)||seen.has(command.id)||command.label.length>80||command.description.length>256||command.disabledReason.length>256)throw Error('COMMAND_SEARCH_CONTRACT');seen.add(command.id);}
    const query=this.query.trim().toLocaleLowerCase();return query?commands.filter(command=>(command.label+' '+command.description).toLocaleLowerCase().includes(query)):commands;
  }
  async open(opener:HTMLElement){
    if(this.disposed)throw Error('COMMAND_SEARCH_DISPOSED');if(this.opened)return;
    const next=this.memory.create(4096,()=>({query:'',message:''})),epoch=this.epoch+1;let unpin:()=>void;
    try{unpin=this.memory.action([next],{epoch});}catch(error){next.release();throw error;}
    this.lease=next;this.query='';this.message='';this.opener=opener;this.opened=true;this.epoch=epoch;
    const pending=Promise.resolve().then(async()=>{try{await this.panels();if(!this.current(epoch))return;this.changed();await this.host.updateComplete;if(!this.current(epoch))return;this.host.querySelector<EnDialog>('#command-search-dialog')?.show();await this.host.updateComplete;if(this.current(epoch))this.host.querySelector<HTMLElement>('#command-search-query')?.focus();}
      catch(error){if(this.current(epoch))await this.close();throw error;}
    }).finally(()=>{unpin();this.pending.delete(pending);});this.pending.add(pending);return pending;
  }
  async close(restore=true){
    this.epoch++;const epoch=this.epoch;this.#controls.invalidate();this.opened=false;this.composing=false;this.query='';this.message='';const lease=this.lease,rendered=this.rendered;this.lease=null;this.rendered=null;const opener=this.opener;this.opener=null;
    const retiring:Promise<void>[]=[];if(lease)retiring.push(this.memory.retire(lease));if(rendered)retiring.push(this.memory.retire(rendered));
    if(retiring.length){const results=await Promise.allSettled(retiring),errors=results.filter((value):value is PromiseRejectedResult=>value.status==='rejected').map(value=>value.reason);if(errors.length)throw new AggregateError(errors,'COMMAND_SEARCH_RENDER_RELEASE_FAILED');}else{this.changed();await this.host.updateComplete;}
    await this.memory.drainRetired();
    if(restore&&!this.disposed&&epoch===this.epoch){if(opener?.isConnected)opener.focus();else this.host.querySelector<HTMLElement>('#command-search-trigger')?.focus();}
  }
  async dispose(){this.disposed=true;const errors:unknown[]=[];try{await this.close(false);}catch(error){errors.push(error);}await Promise.allSettled([...this.pending]);try{await this.memory.drain();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'COMMAND_SEARCH_RELEASE_FAILED');}
  private field(event:Event,epoch:number){
    const control=event.currentTarget as HTMLElement&{value:string};if(!this.current(epoch)){event.preventDefault();return;}
    let release:()=>void;try{release=this.memory.action([this.lease,this.rendered],{epoch});}catch(error){this.#controls.write(control,'value',this.query);this.editor.fail(error);return;}
    this.#controls.settled(event,()=>control.value,value=>{try{if(!this.current(epoch))return;if(value.length>256){this.#controls.write(control,'value',this.query);this.publish(this.query,'Search is limited to 256 characters.');}else try{this.publish(value,'');}catch(error){this.#controls.write(control,'value',this.query);throw error;}this.changed();}catch(error){this.editor.fail(error);}});queueMicrotask(release);
  }
  private dialogChange(event:Event,epoch:number){
    if(!this.current(epoch))return;const control=event.currentTarget as EnDialog;let release:()=>void;
    try{release=this.memory.action([this.lease,this.rendered],{epoch});}catch(error){event.preventDefault();this.#controls.write(control,'open',true);this.editor.fail(error);return;}
    this.#controls.settled(event,()=>control.open,open=>{if(this.current(epoch)&&!open)void this.close().catch(error=>this.editor.fail(error));});queueMicrotask(release);
  }
  #execute(id:string,owner:ReturnType<CommandSearch['owner']>,renderEpoch:number){
    if(!this.current(renderEpoch)||this.composing)return;if(!this.owns(owner)){this.publish(this.query,'The document or selection changed. Choose the current command again.');this.changed();return;}
    const command=this.#items().find(item=>item.id===id);if(!command)return;
    if(command.disabledReason){this.publish(this.query,command.label+': '+command.disabledReason);this.changed();return;}
    const unpin=this.memory.action([this.lease,this.rendered],{id,owner}),epoch=this.epoch;
    const pending=(async()=>{
      // Closing search first preserves a stable opener for the next dialog.
      await this.close();if(!this.owns(owner))return;
      let run:ShellCommand['run'];{const current=this.#items().find(item=>item.id===id);if(!current||current.disabledReason||this.epoch!==epoch+1)return;run=current.run;}
      await run();
    })().catch(error=>this.editor.fail(error)).finally(()=>{unpin();this.pending.delete(pending);});this.pending.add(pending);
  }
  #key(event:KeyboardEvent,epoch:number){
    if(!this.current(epoch)||event.defaultPrevented||event.isComposing||this.composing||event.keyCode===229||event.metaKey||event.ctrlKey||event.altKey)return;
    const query=this.host.querySelector<HTMLElement>('#command-search-query'),rows=[...this.host.querySelectorAll<HTMLElement>('[data-command-search-id]')];
    const path=event.composedPath(),at=rows.findIndex(row=>path.includes(row)),inQuery=!!query&&path.includes(query);
    if(inQuery&&event.key==='ArrowDown'){event.preventDefault();rows[0]?.focus();}
    else if(at>=0&&['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?rows.length-1:event.key==='ArrowDown'?Math.min(rows.length-1,at+1):at-1;if(next<0)query?.focus();else rows[next]?.focus();}
    else if(inQuery&&event.key==='Enter'&&!event.repeat){const id=this.#items()[0]?.id,owner=this.owner();if(id)this.#action(event,epoch,()=>this.#execute(id,owner,epoch));}
  }
  render(){
    if(!this.opened||this.disposed)return nothing;const next=this.memory.create(65536,()=>this.#items().map(({id,label,description,disabledReason})=>({id,label,description,disabledReason}))),prior=this.rendered;this.rendered=next;if(prior)void this.memory.retire(prior,false).catch(error=>this.editor.fail(error));const items=next.value,owner=this.owner(),epoch=this.epoch;
    return html`<en-dialog id="command-search-dialog" label="Command search" .open=${this.opened} @en-change=${(event:Event)=>this.dialogChange(event,epoch)}>
      <section aria-label="Available editor commands" @keydown=${(event:KeyboardEvent)=>this.#key(event,epoch)} @compositionstart=${()=>{if(this.current(epoch))this.composing=true;}} @compositionend=${()=>{if(this.current(epoch))this.composing=false;}}>
        <en-text-field id="command-search-query" label="Search commands" .value=${this.query} .maxLength=${256} @en-input=${(event:Event)=>this.field(event,epoch)} @en-change=${(event:Event)=>this.field(event,epoch)}></en-text-field>
        <p>Tab or Arrow Down visits matching commands. Enter activates a command. Unavailable commands include a reason.</p>
        <p role="status">${this.message||`${items.length} matching commands.`}</p>
        <ul aria-label="Matching commands">${repeat(items,item=>item.id,item=>{const id=item.id;return html`<li><en-button data-command-search-id=${id} aria-describedby=${'command-search-reason-'+id} aria-disabled=${String(!!item.disabledReason)} @click=${(event:Event)=>this.#action(event,epoch,()=>this.#execute(id,owner,epoch))}>${item.label}</en-button><p id=${'command-search-reason-'+id}>${item.disabledReason||item.description}</p></li>`;})}</ul>
        ${!items.length?html`<p>No matching commands. Change the search text.</p>`:nothing}
      </section><en-button slot="footer" variant="secondary" @click=${(event:Event)=>this.#action(event,epoch,()=>{if(this.current(epoch))void this.close().catch(error=>this.editor.fail(error));})}>Close command search</en-button>
    </en-dialog>`;
  }
}
