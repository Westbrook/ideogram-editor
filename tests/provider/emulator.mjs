// This dependency injection entry point is intentionally outside the production build.
import { providerBoundary } from '../../dist/local/server/provider/client.js';
export const SENTINEL_KEY='fixture-key-never-production-P21';
export const SENTINEL_COOKIE='fixture-cookie-never-production-P21';
export function fixtureProfile(overrides={}) {
  return {id:'local-fixture-v1',version:1,evidenceDigest:'a'.repeat(64),endpoint:'ideogram/v4',mode:'fixture',
    enforcement:'observed',lifecycleSeconds:60,minimumCompatibleSeconds:60,acl:'fixture-private',
    supportedLifetimes:[60,120],supportedACLs:['fixture-private','fixture-public'],mostPrivateACL:'fixture-private',
    deferredFetch:'bounded',requiredLifetimeSeconds:60,renewalQualified:false,...overrides};
}
export function emulator({queueOrigin,mediaOrigin,uploadOrigin,ca,resolve,connectMs,readMs,profiles=[fixtureProfile()]}) {
  const origins=[queueOrigin,mediaOrigin,uploadOrigin].filter(Boolean);
  for(const raw of origins){const u=new URL(raw);if(u.origin!==raw||!['127.0.0.1','localhost'].includes(u.hostname)||!u.port)throw Error('Not a fixed local fixture origin');}
  return providerBoundary({mode:'fixture',queueOrigin,mediaOrigins:[mediaOrigin],uploadOrigin,profiles,
    credential:{queueKey:()=>SENTINEL_KEY},connection:{mode:'fixture',fixtureOrigins:origins,fixtureCA:ca,
      resolve:resolve??(async()=>[{address:'127.0.0.1',family:4}]),connectMs,readMs}});
}
