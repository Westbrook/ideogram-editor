// A process-restart oracle: only known engine messages from a retired local
// event-delivery URL, inside the intentional outage, are expected failures.
export function expectedShutdownConsole(observation:{browser:string;text:string;url:string;disrupting:boolean;retiredOrigins:ReadonlySet<string>}):boolean {
 if(!observation.disrupting)return false;
 let url:URL;try{url=new URL(observation.url);}catch{return false;}
 if(!observation.retiredOrigins.has(url.origin)||!['/api/v1/events','/api/v1/events/stream'].includes(url.pathname))return false;
 if(observation.browser==='webkit')return ['Failed to load resource: The network connection was lost.','Failed to load resource: Could not connect to the server.'].includes(observation.text);
 return observation.browser==='chromium'&&/^Failed to load resource: net::(?:ERR_INCOMPLETE_CHUNKED_ENCODING|ERR_CONNECTION_REFUSED|ERR_EMPTY_RESPONSE)$/.test(observation.text);
}
