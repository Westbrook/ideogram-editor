import {nothing} from 'lit';
import {AsyncDirective,directive,PartType,type AttributePart,type PartInfo} from 'lit/async-directive.js';
import {acquireDisplayPreviewConsumer,displayPreviewInfo} from '../observability/display-preview.js';

/** Resource attributes have an application owner before native decoding begins.
 * Detached Lit branches clear the attribute and release their allowance; a
 * reconnect admits it again before restoring the resource. */
export class DisplayImageDirective extends AsyncDirective {
  private element?:Element;private attribute='';private url='';private consumer?:ReturnType<typeof acquireDisplayPreviewConsumer>;private failedURL:string|null=null;
  constructor(info:PartInfo){super(info);if(info.type!==PartType.ATTRIBUTE||!((info.tagName.toLowerCase()==='img'&&info.name==='src')||(info.tagName.toLowerCase()==='image'&&info.name==='href')))throw Error('DISPLAY_IMAGE_ATTRIBUTE');}
  render(url:string|typeof nothing){return url;}
  update(part:AttributePart,[value]:[string|typeof nothing]){
    const url=typeof value==='string'?value:'';
    if(this.element!==part.element||this.attribute!==part.name||this.url!==url){this.release();this.element=part.element;this.attribute=part.name;this.url=url;this.failedURL=null;}
    return this.isConnected?this.attach():nothing;
  }
  private attach(){
    if(!this.url||this.failedURL===this.url||!displayPreviewInfo(this.url))return nothing;
    if(!this.consumer)try{const element=this.element!,attribute=this.attribute,url=this.url;this.consumer=acquireDisplayPreviewConsumer(url,()=>{if(element.getAttribute(attribute)===url)element.removeAttribute(attribute);});}
    catch(error){this.failedURL=this.url;const element=this.element,message=error instanceof Error?error.message:String(error);queueMicrotask(()=>element?.dispatchEvent(new CustomEvent('ie-display-error',{bubbles:true,composed:true,detail:{message:'Preview display could not be admitted: '+message}})));return nothing;}
    return this.url;
  }
  private release(){this.consumer?.release();this.consumer=undefined;}
  protected disconnected(){this.release();this.setValue(nothing);}
  protected reconnected(){this.failedURL=null;this.setValue(this.attach());}
}
export const displayImage=directive(DisplayImageDirective);
