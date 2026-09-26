import { openWriter } from '../../dist/local/server/storage/writer.js';
import { startLocalServer } from '../../dist/local/server/http.js';
import { rootFor, expectedBytes, refFor, command } from '../store/helpers.mjs';
import { pair, call, cookieFrom, readHeaders, mutationHeaders } from '../session/helpers.mjs';
export { pair, call, cookieFrom, readHeaders, mutationHeaders, rootFor, command, expectedBytes, refFor };
export async function setup(t, options={}) {
  const root=await rootFor(t); const writer=await openWriter({root});
  const ref=await writer.putObject([expectedBytes],refFor(expectedBytes),writer.epoch);await writer.close();
  const server=await startLocalServer({root,...options});t.after(()=>server.close());
  let paired=await pair(server);
  return {root,ref,server,get paired(){return paired;},set paired(v){paired=v;},
    read:(path,headers={})=>call(server.origin,path,{headers:{...readHeaders(cookieFrom(paired)),...headers}}),
    post:(path,body,headers={})=>call(server.origin,path,{method:'POST',body,headers:{...mutationHeaders(server,paired),...headers}}),
    command:(patch={},body={})=>command(ref,{clientId:paired.json.clientId,...patch},body)};
}
