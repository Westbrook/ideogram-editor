import type {StoreDatabase} from '../storage/database.js';
import {validateProviderRuntimeConfiguration} from './config.js';
import type {ProviderRuntimeConfig} from './config.js';
import {createProductionProvider} from './index.js';
import {ProviderExecution} from './runtime-core.js';
/** Only sealed production construction is reachable from the normal launcher. */
export class ProviderRuntime extends ProviderExecution {
 constructor(store:StoreDatabase,input:ProviderRuntimeConfig={mode:'disabled'}){
  const config=validateProviderRuntimeConfiguration(input);
  super(store,config,config.mode==='fal'?{provider:createProductionProvider({queueKey:()=>config.key})}:{});
 }
}
