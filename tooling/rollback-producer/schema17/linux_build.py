"""Fresh Linux builds for the separately generated schema17/18 packet producers.
No work is performed on import. Every source input and host selection has an
independently supplied digest; only explicit CLI build starts installation.
"""
from pathlib import Path
import json
import os
import re
import shutil
import subprocess
import sys
from source_reconstitution import reconstitute

CAP18 = 'sha256:c2eb7167875862e82da5f86dc52238001c09852a25c62d2f1bf9be9a2c3f0752'
HELPERS = ['packet.py','transport.py','linux_transport_exact.py','owned_process.py','metadata_policy.py','toolchain.py',
           'linux_host.py','linux_build.py','linux_build_evidence.py','source_reconstitution.py','prepare_source_input.py','foreign_source.py','runtime-selection.mjs','proof.mjs','proof-library-policy.mjs','test_evidence.py','run.py','producer-seal.json']
BUILD_ROLES = ['vendor-before','install','dependencies','typecheck','build-app','build-server','vendor-after','select-runtime','seed','restored']


def build(args, api, version):
    a = api['archive']; trusted=api['trusted']; save=api['save']; ref=api['file_ref']; inventory=api['inventory']; cid=api['content_id']; create=api['create']; command=api['command']
    a.require(sys.platform == 'linux' and version in (17,18), 'Linux producer platform/version required')
    spec=trusted(a.canonical(args.source_input),args.source_input_sha256)
    a.keys(spec,['kind','storageVersion','originArchive','originManifest','sourceBytesModesIdentity','lineage'],['capabilityHash'])
    a.require(spec['kind']=='linux-rollback-source-input-1' and spec['storageVersion']==version and
              (spec.get('capabilityHash')==CAP18 if version==18 else 'capabilityHash' not in spec), 'Source family/capability differs')
    a.require(isinstance(spec['sourceBytesModesIdentity'],str) and re.fullmatch('sha256:[0-9a-f]{64}',spec['sourceBytesModesIdentity']), 'Source bytes/modes trust anchor required')
    # lineage is an exact sealed JSON evidence reference, not an authorization
    # inferred from source metadata or an arbitrary claimed historical commit.
    api['verify_ref'](spec['lineage'])
    selection=trusted(a.canonical(args.host_selection),args.host_selection_sha256)
    output=api['fresh'](Path(args.output)); workspace=api['fresh'](Path(args.workspace)); here=api['HERE']
    repo=a.canonical(args.toolchain_repo)
    try:
        tree=api['acquire_tree'](workspace/'owned',provenance={'sourceInput':ref(Path(args.source_input))},storageVersion=version)
        source,projection_ref=tree.construct(lambda root: reconstitute(spec['originArchive'],spec['originManifest'],root/'source',storage_version=version),kind='source-reconstitution',inputs={'archive':spec['originArchive'],'manifest':spec['originManifest'],'sourceInput':ref(Path(args.source_input))})
        projection=api['sealed_json'](projection_ref)
        a.require(projection['sourceBytesModesIdentity']==spec['sourceBytesModesIdentity'], 'Reconstituted source bytes/modes differ from reviewed identity')
        api['assert_schema17' if version==17 else 'assert_schema18'](source)
        paths=sorted(name for name,row in projection['entries'].items() if row['type']=='file')
        source_closure=create(source,paths,output/'source',role='linux-reconstituted-source',provenance={'sourceInput':ref(Path(args.source_input)),'sourceReconstitution':projection_ref,'metadataEquivalentToOrigin':False},storageVersion=version)
        original=api['sealed_json'](source_closure['manifest']); source_identity=api['rows_identity'](original['entries'])
        arch=api['current_platform']()['arch']; node=a.canonical(str(repo/('.toolchain/node-v26.10.0-linux-'+arch+'/bin/node')))
        npm=repo/'.toolchain/npm-12.1.0/package/bin/npm-cli.js'; pins=api['load'](source/'tooling/toolchain.json')
        a.require(pins['node']=='26.10.0' and pins['npm']=='12.1.0','Captured toolchain pins differ')
        authentication=api['authenticate'](repo,pins);save(output/'toolchain-authentication.json',authentication);auth_ref=ref(output/'toolchain-authentication.json')
        a.require(authentication['node']['members']['bin/node']['path']==str(node),'Authenticated node differs')
        original_env=api['safe_environment'](node,workspace,npm)
        host=api['native_host'](original_env,selection);save(output/'native-host.json',host);host_ref=ref(output/'native-host.json');env={**original_env,**host['environment']}
        a.require(host['platform']['arch']==arch,'Host selection architecture differs')
        commands=[]
        for role,argv in [('vendor-before',['run','verify:vendor']),('install',['ci','--no-audit','--no-fund']),('dependencies',['ls','--all','--json']),('typecheck',['run','typecheck']),('build-app',['run','build:app']),('build-server',['run','build:server']),('vendor-after',['run','verify:vendor'])]:
            commands.append(command([node,npm,*argv],source,output/'logs'/(role+'.log'),env=env))
        after_authentication=api['authenticate'](repo,pins);a.require(after_authentication==authentication,'Toolchain changed during compilation');save(output/'toolchain-after.json',after_authentication)
        after_host=api['native_host'](original_env,selection);a.require(after_host==host,'Host compiler/dependencies changed during compilation');save(output/'native-host-after.json',after_host)
        api['restored_source_paths'](source,paths)
        after_rows=inventory(source,paths);after_identity=api['rows_identity'](after_rows);a.require(after_identity==source_identity,'Compilation changed source bytes/modes')
        after_paths=sorted(name for name,row in after_rows.items() if row['type']=='file')
        save(output/'linux-build.json',{'kind':'linux-fresh-build-observation-1','storageVersion':version,'sourceArchive':source_closure['archive'],'sourceManifest':source_closure['manifest'],'sourceBefore':source_identity,'sourceAfter':after_identity,'membershipBefore':cid(paths),'membershipAfter':cid(after_paths),'toolchainBefore':auth_ref,'toolchainAfter':ref(output/'toolchain-after.json'),'hostBefore':host_ref,'hostAfter':ref(output/'native-host-after.json'),'commands':[{'role':role,'receipt':record['receipt']} for role,record in zip(BUILD_ROLES[:7],commands)],'result':'completed'})
        api['assert_producer_sources']()
        def retain_support(root):
            support=source/'.rollback';support.mkdir(mode=0o700)
            for name in HELPERS:
                (support/name).parent.mkdir(mode=0o700,parents=True,exist_ok=True)
                shutil.copy2(here/name,support/name);a.require(ref(here/name)['hash']==ref(support/name)['hash'],'Copied producer helper drift')
            shutil.copy2(source/'tests/store/no-network.mjs',support/'no-network.mjs')
            shutil.copy2(node,support/'node');shutil.copy2(node.parent.parent/'LICENSE',support/'NODE-LICENSE')
            for name,member in [('node','bin/node'),('NODE-LICENSE','LICENSE')]:
                copied=ref(support/name); expected=authentication['node']['members'][member]
                a.require(copied['hash']==expected['sha256'] and copied['byteLength']==expected['byteLength'],'Copied authenticated runtime differs')
            shutil.copy2(output/'native-host.json',support/'linux-host.json')
            a.require(ref(support/'linux-host.json')['hash']==host_ref['hash'],'Copied native host binding differs')
            return support
        support=tree.construct(retain_support,kind='fixture-construction',inputs={**{name:ref(here/name) for name in HELPERS},'host':host_ref,'node':ref(node),'notice':ref(node.parent.parent/'LICENSE'),'guard':ref(source/'tests/store/no-network.mjs')})
        runtime_selection=output/'runtime-selection.json'
        commands.append(command([node,'--import',support/'no-network.mjs',support/'runtime-selection.mjs',source,runtime_selection],source,output/'logs/select-runtime.log',timeout=120,env=env))
        selected=api['load'](runtime_selection)
        a.require(selected['kind']=='linux-rollback-runtime-selection-1' and selected['platform']=={'os':'linux','arch':arch}
                  and selected['effects']==0 and selected['node']=='26.10.0','Runtime selection requires actual guarded Linux profile')
        includes=selected['includes'];a.require(includes==sorted(set(includes)) and includes and '.rollback' in includes,'Invalid runtime selection')
        for expected in selected['codecFiles']:
            actual=ref(source/expected['path']);a.require(actual['hash']==expected['hash'] and actual['byteLength']==expected['byteLength'],'Runtime codec member differs')
        runtime_rows=inventory(source,includes)
        native_rows={name:row for name,row in runtime_rows.items() if row['type']=='file' and re.search(r'\.(node|so(?:\.[0-9.]+)?)$',name)}
        a.require(native_rows,'Linux native runtime closure absent')
        compiler='node_modules/@typescript/typescript-linux-'+arch
        a.require(api['load'](source/compiler/'package.json')['version']=='7.0.2','Compiler package differs')
        compiler_rows=inventory(source,[compiler,'node_modules/typescript']);platform=api['current_platform']();lock=ref(source/'package-lock.json')
        vendor={name:row for name,row in original['entries'].items() if name.startswith('vendor/') and row['type']=='file'}
        identity={'compiler':{'name':'typescript','version':'7.0.2','identity':api['rows_identity'](compiler_rows)},
                  'toolchain':{'node':'26.10.0','npm':'12.1.0','identity':cid({'authenticatedInputs':auth_ref,'runtime':selected['runtime']})},
                  'dependencies':{'lockfileHash':lock['hash'],'vendorManifestHash':api['rows_identity'](vendor),'identity':api['rows_identity']({n:r for n,r in runtime_rows.items() if n.startswith('node_modules/')})},
                  'native':{'profileHash':cid({'platform':platform,'profiles':selected['profiles'],'nodeABI':selected['runtime']['modules'],'hostBuild':host_ref}),'artifactManifestHash':api['rows_identity'](native_rows)},
                  'platform':{'os':'linux','arch':arch,'identity':cid(platform)}}
        tree.construct(lambda root: save(support/'identities.json',{'identity':identity,'nativeFiles':native_rows,'compilerFiles':compiler_rows,'platform':platform,'runtime':selected['runtime'],'toolchainAuthentication':auth_ref,'nativeHost':host_ref,'commands':commands,'sourceProjection':projection_ref,'sourceInput':ref(Path(args.source_input)),'hostSelection':ref(Path(args.host_selection))}),kind='fixture-construction',inputs={'sourceInput':ref(Path(args.source_input)),'hostSelection':ref(Path(args.host_selection)),'host':host_ref,'authentication':auth_ref})
        proof=workspace/'seed-observation.json';seed_root=tree.root/'seed-root'
        commands.append(command([support/'node','--import',support/'no-network.mjs',support/'proof.mjs','seed',source,seed_root,proof,support/'linux-host.json',host_ref['hash']],source,output/'logs/seed.log',timeout=120,env=env))
        seed=create(seed_root,sorted(p.name for p in seed_root.iterdir()),output/'seed',role='purpose-built-linux-rollback-fixture',provenance={'observation':ref(proof)},storageVersion=version)
        runtime=create(source,includes,output/'application',role='independently-built-linux-runtime',provenance={'sourceIdentity':source_identity,'sourceArchive':source_closure['archive'],'identity':identity},storageVersion=version)
        draft={'kind':f'schema{version}-executable-packet-draft-1','storageVersion':version,'packetId':f'schema{version}-linux-{arch}-'+source_identity[7:31],
               'sourceArchive':source_closure['archive'],'sourceManifest':source_closure['manifest'],**identity,'compiledClosures':[{'name':'application-runtime',**runtime}],
               'sourceIdentity':source_identity,'sourceInput':ref(Path(args.source_input)),'buildObservation':ref(output/'linux-build.json'),'commands':commands,'seedClosure':seed,'seedObservation':ref(proof),'status':'compiled-fresh-restore-required'}
        if version==18:draft['capabilityHash']=CAP18
        api['assert_producer_sources']()
        save(output/'draft.json',draft)
        print(json.dumps({'draft':ref(output/'draft.json'),'executableQualified':False}))
    except BaseException as error:
        a.failure(output,error);raise
