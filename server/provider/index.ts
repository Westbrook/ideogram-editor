import { refuse } from './contracts.js';
import type { CredentialProvider } from './contracts.js';
import { QUEUE_ORIGIN } from './policy.js';
import { providerBoundary } from './client.js';

/** Production has no emulator selection, alternate origin, TLS override or caller-supplied Q09 profiles. */
export function assertProductionConfiguration(config:Record<string,unknown>): void {
  if(Object.keys(config).some(k=>/emulat|fixture|proxy|endpoint|origin|tls|profile/i.test(k)))refuse('POLICY');
}
export function assertProductionEnvironment(environment:NodeJS.ProcessEnv):void {
  if(Object.keys(environment).some(k=>/^(IDEOGRAM_|FAL_|PROVIDER_).*(EMULATOR|FIXTURE)/i.test(k)))refuse('POLICY');
}
export function createProductionProvider(credential:CredentialProvider, config:Record<string,unknown>={}) {
  assertProductionEnvironment(process.env);
  assertProductionConfiguration(config);
  if(Object.keys(config).length)refuse('POLICY');
  return providerBoundary({mode:'production',queueOrigin:QUEUE_ORIGIN,mediaOrigins:[],profiles:[],credential,
    connection:{mode:'production'}});
}
