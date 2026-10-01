import type {Page} from '@playwright/test';

export type LiveMutation={sequence:number;at:number;region:number;role:string|null;politeness:string;text:string;focus:{tag:string;role:string|null;label:string|null}};
/** Observe rendered DOM and open shadow roots through Playwright's public API.
 * This is DOM announcement evidence, never a claim about native spoken output.
 * A MutationObserver records the presented text at a mutation checkpoint; it
 * does not fabricate speech for transient text overwritten before that point. */
export async function liveRegions(page:Page){
  const key='__qualificationLiveRegions_'+Math.random().toString(36).slice(2);
  await page.evaluate(key=>{
    const events:LiveMutation[]=[],previous=new WeakMap<Element,string>(),ids=new WeakMap<Element,number>(),observed=new WeakSet<Node>();let next=0,baseline=true;
    const parent=(node:Node):Node|null=>node instanceof Element&&node.assignedSlot?node.assignedSlot:node.parentNode??(node instanceof ShadowRoot?node.host:null);
    const live=(element:Element)=>element.getAttribute('aria-live')!=='off'&&(element.hasAttribute('aria-live')||['status','alert','log'].includes(element.getAttribute('role')??''));
    const exposed=(element:Element)=>{
      let node:Node|null=element;
      while(node){
        if(node instanceof Element){
          if(node.getAttribute('aria-hidden')==='true'||node.hasAttribute('hidden')||node.hasAttribute('inert'))return false;
          if(node instanceof HTMLDialogElement&&!node.open)return false;
          if(node instanceof HTMLDetailsElement&&!node.open&&!node.querySelector('summary')?.contains(element))return false;
          const style=getComputedStyle(node);if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||style.contentVisibility==='hidden')return false;
        }
        node=parent(node);
      }
      return element.isConnected;
    };
    const text=(node:Node):string=>{
      if(node.nodeType===Node.TEXT_NODE)return node.textContent??'';
      if(node instanceof Element){
        if(['SCRIPT','STYLE'].includes(node.tagName)||node.getAttribute('aria-hidden')==='true'||node.hasAttribute('hidden')||node.hasAttribute('inert'))return '';
        const style=getComputedStyle(node);if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||style.contentVisibility==='hidden')return '';
      }
      if(node instanceof HTMLSlotElement){const assigned=node.assignedNodes({flatten:true});return (assigned.length?assigned:[...node.childNodes]).map(text).join(' ');}
      if(node instanceof Element&&node.shadowRoot)return [...node.shadowRoot.childNodes].map(text).join(' ');
      return [...node.childNodes].map(text).join(' ');
    };
    const focus=()=>{let current=document.activeElement;while(current?.shadowRoot?.activeElement)current=current.shadowRoot.activeElement;return {tag:current?.tagName??'',role:current?.getAttribute('role')??null,label:current?.getAttribute('aria-label')??null};};
    const collect=()=>{
      const elements:Element[]=[];
      const walk=(root:Document|ShadowRoot)=>{if(!observed.has(root)){observed.add(root);new MutationObserver(collect).observe(root,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['aria-live','role','aria-hidden','hidden','inert','open','style','class']});}
        for(const element of root.querySelectorAll('*')){if(live(element))elements.push(element);if(element.shadowRoot)walk(element.shadowRoot);}};
      walk(document);
      for(const element of elements){
        if(!exposed(element)){previous.delete(element);continue;}
        let ancestor=parent(element),nested=false;while(ancestor){if(ancestor instanceof Element&&live(ancestor)){nested=true;break;}ancestor=parent(ancestor);}if(nested)continue;
        const value=text(element).replace(/\s+/g,' ').trim(),prior=previous.get(element);previous.set(element,value);
        if(!ids.has(element))ids.set(element,++next);
        if(!baseline&&value&&value!==prior)events.push({sequence:events.length+1,at:performance.now(),region:ids.get(element)!,role:element.getAttribute('role'),politeness:element.getAttribute('aria-live')??(element.getAttribute('role')==='alert'?'assertive':'polite'),text:value,focus:focus()});
      }
    };
    collect();baseline=false;
    (window as unknown as Record<string,unknown>)[key]=events;
  },key);
  return {events:()=>page.evaluate(key=>(window as unknown as Record<string,LiveMutation[]>)[key]??[],key)};
}
