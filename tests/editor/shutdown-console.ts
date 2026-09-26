// A process-restart oracle: only known engine messages from a retired local
// event-delivery URL, inside the intentional outage, are expected failures.
export function expectedShutdownConsole(observation:{browser:string;text:string;url:string;disrupting:boolean;retiredOrigins:ReadonlySet<string>}):boolean {
 if(!observation.disrupting)return false;
 let url:URL;try{url=new URL(observation.url);}catch{return false;}
 if(!observation.retiredOrigins.has(url.origin)||!['/api/v1/events','/api/v1/events/stream'].includes(url.pathname))return false;
 if(observation.browser==='webkit')return ['Failed to load resource: The network connection was lost.','Failed to load resource: Could not connect to the server.'].includes(observation.text);
 return observation.browser==='chromium'&&/^Failed to load resource: net::(?:ERR_INCOMPLETE_CHUNKED_ENCODING|ERR_CONNECTION_REFUSED|ERR_EMPTY_RESPONSE)$/.test(observation.text);
}

// Playwright 1.63 WebKit forwards a JavaScript-source network console diagnostic
// as pageerror, splitting its URL at the colon. This exception is paired with
// an independent, unconditional DOM error/unhandledrejection assertion.
export function expectedShutdownPageError(observation:{browser:string;name:string;message:string;stack:string;disrupting:boolean;retiredOrigins:ReadonlySet<string>}):boolean {
 if(observation.browser!=='webkit'||!observation.disrupting||observation.name!=='Fetch API cannot load http'||observation.stack!=='')return false;
 if(!/^\/127\.0\.0\.1:[1-9]\d*\/api\/v1\/events(?:\/stream)?\?after=(?:0|[1-9]\d*) due to access control checks\.$/.test(observation.message))return false;
 try{return observation.retiredOrigins.has(new URL('http:/'+observation.message.slice(0,-' due to access control checks.'.length)).origin);}catch{return false;}
}
