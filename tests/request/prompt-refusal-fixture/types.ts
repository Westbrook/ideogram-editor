export type Usage={cpuBytes:number;promptBytes:number;handles:number;activeRecords:number};
export type Saved={id:string;text:string;operation:string;mode:string;generation:string;composing:boolean};
export type NativeEvent={type:string;trusted:boolean;cancelable:boolean;prevented:boolean;inputType:string;isComposing:boolean;units:number;start:number;end:number;maximum:number};
export type Snapshot={saved:Saved[];refused:boolean;refusedIds:string[];registrations:number;uiPins:number;commands:string[];usage:Usage;events:NativeEvent[];errors:string[];disposed:boolean};
export interface PromptFixture {
 snapshot():Snapshot;
 pressure(remaining?:number):Promise<void>;
 releasePressure():void;
 repaint():Promise<void>;
 dispose():Promise<{before:Usage;after:Usage;registrations:number;uiPins:number;responseOwners:number}>;
}
declare global {interface Window {promptFixture:PromptFixture;}}
