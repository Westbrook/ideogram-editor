import type {StoreDatabase} from '../storage/database.js';
import {validateProviderRuntimeConfiguration} from './config.js';
import type {ProviderRuntimeConfig,V45BlockedRuntimeConfig} from './config.js';
import type {ProviderView} from '../../src/protocol/provider.js';
import {createProductionProvider} from './index.js';
import {ProviderExecution} from './runtime-core.js';
import {V45_PROFILE_BLOCKERS} from './v45-profile.js';
/** Only sealed production construction is reachable from the normal launcher. */
export class ProviderRuntime extends ProviderExecution {
 private readonly v45:V45BlockedRuntimeConfig|null;private readonly epoch:string;
 constructor(store:StoreDatabase,input:ProviderRuntimeConfig={mode:'disabled'}){
  const config=validateProviderRuntimeConfiguration(input),blocked=config.mode==='fal-v45-blocked';
  super(store,blocked?{mode:'disabled'}:config,config.mode==='fal'?{provider:createProductionProvider({queueKey:()=>config.key})}:{});
  this.v45=blocked?config:null;this.epoch=store.epoch;
 }
 override view():ProviderView {
  if(!this.v45)return super.view();
  return {protocolVersion:1,mode:this.v45.requestedMode,ready:false,state:'admission-blocked',configurationId:null,configurationHash:null,epoch:this.epoch,credentialConfigured:false,
   operation:'generate-v45',endpoint:'ideogram/v4.5',profile:null,limits:null,
   admission:{policy:'unknown-withheld-1',state:'blocked',reason:'provider-safety-evidence-unavailable',ordinaryDisplay:false,adoption:false,export:false},
   message:'Ideogram v4.5 is selected for local review only. Its declared output has no per-image safety evidence. Live authorization is blocked; no approval or key file was read. Explicit V4 compatibility remains a separate configuration. '+V45_PROFILE_BLOCKERS.map(blocker=>blocker.explanation).join(' ')};
 }
}
