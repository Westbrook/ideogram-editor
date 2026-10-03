"""Create a reviewed source-selection candidate from a genuine sealed old packet.
This checks identities and retained receipt fields without executing or asserting
Linux qualification. The Linux build and exact fresh restore remain mandatory.
"""
from pathlib import Path

def prepare(args, api, version):
    a=api['archive']; trusted=api['trusted']; ref=api['file_ref']; read=api['sealed_json']; cid=api['content_id']
    packet=trusted(a.canonical(args.origin_packet),args.origin_packet_sha256)
    pin=trusted(a.canonical(args.origin_pin),args.origin_pin_sha256)
    a.require(packet['kind']==f'schema{version}-executable-packet-1' and packet['storageVersion']==version, 'Origin packet family differs')
    a.keys(pin,['kind','packetId','identityHash','platform'])
    a.require(pin['kind']==f'schema{version}-executable-pin-1' and pin['packetId']==packet['packetId'] and pin['identityHash']==api['packet_identity'](packet) and pin['platform']==packet['platform'], 'Reviewed origin pin does not bind packet')
    if version==18:
        a.require(api['CAPABILITY18']==packet['capabilityHash'], 'Origin capability differs')
    proof=packet['verifiedFreshRestore']; receipt=read(proof['receipt'],65536)
    a.require(proof['result']=='verified' and receipt['result']=='verified' and receipt['kind']==f'schema{version}-fresh-restore-1' and receipt['storageVersion']==version, 'Origin lacks retained actual restore receipt')
    a.require(proof['sourceArchiveHash']==receipt['sourceArchiveHash']==packet['sourceArchive']['hash'] and proof['compiledClosureHash']==receipt['compiledClosureHash']==api['closure_identity'](packet['compiledClosures']), 'Origin receipt archive binding differs')
    a.require(receipt['checks']['freshRestore'] is True and receipt['checks'][f'openExistingSchema{version}'] is True and receipt['checks']['replayByteIdentity'] is True and type(receipt['checks']['networkEffects']) is int and receipt['checks']['networkEffects']==0,'Origin receipt incomplete')
    manifest=read(packet['sourceManifest']); api['verify_ref'](packet['sourceArchive'])
    a.require(manifest['kind']=='schema17-closure-transport-2' and manifest['metadataPolicy']=='schema17-executable-metadata-2' and manifest['originalsUnchanged'] is True, 'Unsupported origin source transport')
    a.require(all(manifest['archive'][key]==packet['sourceArchive'][key] for key in ['hash','byteLength']), 'Origin source binding differs')
    rows=manifest['entries'];a.require(isinstance(rows,dict) and 0<len(rows)<=200000,'Invalid origin source inventory')
    projection={}
    for name,row in rows.items():
        # This is a projection proposal; reconstitution performs complete archive,
        # ancestor, member, metadata and content verification before materializing.
        a.require(row.get('type') in ('file','directory') and type(row.get('mode')) is int and 0<=row['mode']<=0o777,'Unsupported origin source shape')
        projection[name]={k:row[k] for k in ['type','mode','bytes','sha256'] if k in row}
    output=api['fresh'](Path(args.output))
    observation=lambda value:{k:value[k] for k in ['hash','byteLength']}
    lineage={'kind':'linux-source-origin-lineage-1','storageVersion':version,'originPacket':observation(ref(Path(args.origin_packet))),
             'originPin':pin,'originPinFile':observation(ref(Path(args.origin_pin))),'originPlatform':packet['platform'],
             'sourceArchive':observation(packet['sourceArchive']),'sourceManifest':observation(packet['sourceManifest']),
             'actualOriginReceipt':observation(proof['receipt']),'metadataEquivalent':False,'linuxExecutableQualified':False,
             'authority':'Source selection derives only from the separately reviewed original packet pin; no Linux executable authority.'}
    api['save'](output/'lineage.json',lineage)
    value={'kind':'linux-rollback-source-input-1','storageVersion':version,'originArchive':packet['sourceArchive'],
           'originManifest':packet['sourceManifest'],'sourceBytesModesIdentity':cid(projection),'lineage':ref(output/'lineage.json')}
    if version==18:value['capabilityHash']=api['CAPABILITY18']
    api['save'](output/'source-input.json',value)
    print(api['json'].dumps({'sourceInput':ref(output/'source-input.json'),'reviewRequired':True,'linuxExecutableQualified':False}))
