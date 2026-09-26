// The HTTP process binds a literal loopback listener. Node calls dns.lookup even
// for that literal. Permit only this non-egress resolution; all outbound socket,
// HTTP/fetch, nonliteral DNS and datagram operations keep the shared deny counter.
import dns from 'node:dns';
const lookup=dns.lookup;
await import('../store/no-network.mjs');
const deny=dns.lookup;
dns.lookup=function(host,...args){return host==='127.0.0.1'?lookup.call(this,host,...args):deny.call(this,host,...args);};
