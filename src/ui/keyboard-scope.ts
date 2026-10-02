/** Resolve actual focused keyboard ownership through open component shadows. */
export function shortcutPath(event:KeyboardEvent,scope:HTMLElement):HTMLElement[]|null{
 if(event.defaultPrevented||event.repeat||event.isComposing||event.keyCode===229||!scope.isConnected)return null;
 const path=event.composedPath().filter((node):node is HTMLElement=>node instanceof HTMLElement);
 return shortcutFocus(path,scope)?path:null;
}
/** Recheck captured ownership after dispatch; Event.composedPath then expires. */
export function shortcutFocus(path:readonly HTMLElement[],scope:HTMLElement):boolean{
 if(!scope.isConnected||!path.includes(scope)||path.some(node=>!node.isConnected||node.inert||node.hidden||node.getAttribute('aria-disabled')==='true'||('disabled' in node&&node.disabled===true)||node.isContentEditable||node.matches('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="searchbox"],[role="combobox"],[role="spinbutton"],[role="slider"],en-text-field,en-textarea,en-number-field,en-select,en-slider,en-color-field')))return false;
 let active=scope.ownerDocument.activeElement;while(active?.shadowRoot?.activeElement)active=active.shadowRoot.activeElement;
 if(!(active instanceof HTMLElement)||!path.includes(active))return false;
 let current:HTMLElement|null=active;
 while(current&&current!==scope){if(!path.includes(current))return false;const root=current.getRootNode() as ShadowRoot;current=current.parentElement??(root.host instanceof HTMLElement?root.host:null);}
 return current===scope;
}

/** Button Space/Enter and component navigation remain the component's actions. */
export function shortcutActivation(path:readonly HTMLElement[]):boolean{
 return path.some(node=>node.matches('button,a[href],en-button,en-link,[role="button"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="radio"],[role="switch"]'));
}
/** Only a request's own responsive drawer may host its local shortcut. */
export function shortcutModalConflict(host:HTMLElement,path:readonly HTMLElement[],allowedDrawerId?:string):boolean{
 for(const node of host.querySelectorAll<HTMLElement>('en-dialog,en-drawer,dialog,[role="dialog"][aria-modal="true"]')){
  const open='open' in node?node.open===true:node.getAttribute('aria-modal')==='true'&&!node.hidden&&node.getAttribute('aria-hidden')!=='true';
  if(!open)continue;
  if(allowedDrawerId&&node.tagName==='EN-DRAWER'&&node.id===allowedDrawerId&&path.includes(node))continue;
  return true;
 }
 return false;
}
