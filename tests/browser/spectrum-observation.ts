export function sanitizedLocation(value:string){
 try{const url=new URL(value);return {origin:url.origin,path:url.pathname};}catch{return {origin:'unavailable',path:'unavailable'};}
}
export function sanitizedText(value:string){
 return value.replace(/https?:\/\/[^\s"'<>]+/g,raw=>{const location=sanitizedLocation(raw);return location.origin+location.path;}).replace(/#pairing=[^\s"'<>]+/g,'#pairing=<redacted>');
}
