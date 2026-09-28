// Explicit simulated original-object ledger for NON-BROWSER partition controls.
export function privateServerRows(receipt,id){
 const base={id,serverId:1,pid:receipt.pid,method:receipt.method,url:receipt.path,path:receipt.path,requestObject:true,responseObject:true,responseRequestSame:true},status=receipt.responseStatus;
 const headers=status===200?{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; base-uri 'none'; frame-ancestors 'none'"}:null;
 return [{...base,kind:'request',headers:structuredClone(receipt.headers),rawHeaders:structuredClone(receipt.rawHeaders),...receipt.socket},
 {...base,kind:'header-call',name:'writeHead',sameResponseObject:true,args:headers?[status,headers]:[status],statusBefore:200},
 {...base,kind:'header-return',name:'writeHead',sameResponseObject:true,returnIsResponse:true,returnType:'object',status,headers:{},headersSent:true},
 ...['response','response-close'].map(kind=>({...base,kind,status,headers:{},writableFinished:true,headersSent:true,originalObjects:true}))].map((r,i)=>({...r,sequence:(id-1)*5+i+1}));
}
