import assert from 'node:assert/strict';
import {headers} from './app-buffer-core.mjs';

export function networkForEpoch(network,e){const ids=new Set(e.closedNetworkIds??[]);for(const n of network){const p=n.params;const urls=[p.request?.url,p.response?.url].filter(Boolean);if(urls.some(u=>new URL(u).origin===e.origin)||n.name==='Network.requestWillBeSentExtraInfo'&&headers(p.headers).host===new URL(e.origin).host)ids.add(p.requestId);}return network.filter(n=>ids.has(n.params.requestId));}

export function assertProtocolOwnership(network,epochs,select){
 const memberships=epochs.map(e=>new Set(select(e)));
 for(const event of network){
  let owners=0;
  for(const membership of memberships)if(membership.has(event))owners++;
  assert.equal(owners,1,'Every protocol event owns exactly one epoch');
 }
}
