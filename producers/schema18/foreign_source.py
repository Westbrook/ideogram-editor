"""Typed inert original metadata boundary inside a new Linux evidence graph.
Original source bytes and its complete manifest are retained. Absolute references
inside that foreign manifest describe its original Darwin capture; they do not
supply executable authority to this independently built Linux packet.
"""

def foreign_source_manifest(spec, read, require, version):
    require(spec.get('kind')=='linux-rollback-source-input-1' and spec.get('storageVersion')==version, 'Invalid retained source input')
    ref=spec['originManifest']; value=read(ref)
    require(value.get('kind')=='schema17-closure-transport-2' and value.get('metadataPolicy')=='schema17-executable-metadata-2'
            and value.get('originalsUnchanged') is True and value.get('status')=='copied-restore-pending', 'Unsupported inert source manifest')
    require(all(value['archive'][key]==spec['originArchive'][key] for key in ['hash','byteLength']), 'Inert source archive binding differs')
    require(isinstance(value.get('entries'),dict) and 0<len(value['entries'])<=200000, 'Inert source inventory bound')
    return (ref['hash'],ref['byteLength'])
