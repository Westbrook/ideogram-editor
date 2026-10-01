import {main} from './qualification/development.mjs';
import {nodeGroups} from './qualification/suite-prerequisites.mjs';
export const suites=Object.freeze(Object.values(nodeGroups).flat());
export function nodeArguments(requested){
  for(const name of requested)if(!suites.includes(name)&&!['all','base','features','helpers','tooling'].includes(name))throw Error(`Unknown Node suite: ${name}`);
  if(requested.some(name=>['all','base','features','helpers','tooling'].includes(name))&&requested.length!==1)throw Error('Group aliases cannot be mixed with individual suites');
  return ['run','--groups',requested.length?[...new Set(requested)].join(','):'base'];
}
if(import.meta.main)main(nodeArguments(process.argv.slice(2))).catch(error=>{console.error(error.message);process.exitCode=1;});
