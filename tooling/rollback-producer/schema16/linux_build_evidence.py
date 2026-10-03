"""Validate the actual fresh Linux build receipt, independent of Darwin runs."""
from transport import content_id
ROLES=['vendor-before','install','dependencies','typecheck','build-app','build-server','vendor-after']
def verify_linux_build(draft,read,require,identity):
    build=read(draft['buildObservation']);source=read(draft['sourceManifest'])
    require(set(build)=={'kind','storageVersion','sourceArchive','sourceManifest','sourceBefore','sourceAfter','membershipBefore','membershipAfter','toolchainBefore','toolchainAfter','hostBefore','hostAfter','commands','result'},'Unknown Linux build evidence fields')
    require(build['kind']=='linux-fresh-build-observation-1' and build['storageVersion']==draft['storageVersion'] and build['result']=='completed','Wrong Linux build evidence family')
    same=lambda left,right: all(left[key]==right[key] for key in ('hash','byteLength'))
    require(same(build['sourceArchive'],draft['sourceArchive']) and same(build['sourceManifest'],draft['sourceManifest']),'Linux build names different source closure')
    require(build['sourceBefore']==build['sourceAfter']==draft['sourceIdentity']==identity(source['entries']),'Linux build source changed')
    require(build['membershipBefore']==build['membershipAfter']==content_id(sorted(name for name,row in source['entries'].items() if row['type']=='file')),'Linux build source membership changed')
    require(same(build['toolchainBefore'],build['toolchainAfter']) and read(build['toolchainBefore'])==read(build['toolchainAfter']),'Linux authenticated toolchain changed')
    require(same(build['hostBefore'],build['hostAfter']) and read(build['hostBefore'])==read(build['hostAfter']),'Linux host changed during build')
    require(len(build['commands'])==len(ROLES) and [item['role'] for item in build['commands']]==ROLES,'Linux build command set differs')
    require(len(draft['commands'])>=len(ROLES),'Linux build commands absent')
    for index,item in enumerate(build['commands']):
        require(same(item['receipt'],draft['commands'][index]['receipt']),'Linux draft/build command identity differs')
        record=read(item['receipt'])
        require(record['kind']=='linux-owned-command-result-1' and type(record['exitCode']) is int and record['exitCode']==0 and record['failure'] is None and record['processGroupDrained'] is True and record['ownedDescendantsDrained'] is True,'Linux build command did not complete and drain')
