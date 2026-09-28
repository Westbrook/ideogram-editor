// Setup has not admitted storage, so this path never invokes a storage reset.
export async function acquireOwnedSetup(steps) {
  const resources={},acquired=[],cleanup=[];
  try{for(const [name,acquire,release] of steps){resources[name]=await acquire(resources);acquired.push({name,release});}return resources;}
  catch(primary){for(const {name,release} of acquired.reverse())if(release)try{await release(resources[name],resources);}catch(error){cleanup.push({name,error});}
    throw Object.assign(new AggregateError([primary,...cleanup.map(x=>x.error)],'Owned fixture setup and independent cleanup'),{primary,cleanup,acquired:acquired.map(x=>x.name)});
  }
}
