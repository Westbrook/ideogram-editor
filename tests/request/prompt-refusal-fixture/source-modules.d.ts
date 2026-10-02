// The Vite alias selects one complete effective source tree at test execution.
// This declaration describes only the boundary used by the browser fixture.
declare module '@request-prompt-source/ui/request.js' {
 export class RequestEditing {constructor(host:import('lit').LitElement,editor:unknown);readonly operation:string;operationChoice(changed:(value:string)=>void):(event:Event)=>void;sync():Promise<void>;render():unknown;dispose():Promise<void>;}
}
declare module '@request-prompt-source/observability/allocations.js' {
 export interface Lease {release():void;}
 export const ALLOCATION_LIMITS:{promptBytes:number};
 export const allocationLedger:{snapshot():{cpuBytes:number;promptBytes:number;handles:number;activeRecords:number;refusals:number};reserve(value:{owner:string;kind:'prompt';cpuBytes:number}):Lease};
}
declare module '@request-prompt-source/observability/model-memory.js' {
 export interface Owned<T> {value:T;pin():()=>void;release():void;}
 export function cloneOwnedModel<T>(owner:string,value:T):Owned<T>;
}
