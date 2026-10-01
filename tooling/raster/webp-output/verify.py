"""Native file transport parity against the unchanged sealed decoder ABI.

All pixel storage is anonymous mmap or small I/O blocks; this test does not use
full-image Python/Node heap buffers. Whole application RSS is qualified elsewhere.
"""
import ctypes as c
import hashlib
import json
import mmap
import os
from pathlib import Path
import sys
import tempfile

bridge_path, decoder_path, root_arg = sys.argv[1:]
root = Path(root_arg)
bridge = c.CDLL(bridge_path)
decoder = c.CDLL(decoder_path)
u64p = c.POINTER(c.c_uint64)
decoder.IEWebPDecodeRGBA.argtypes = [c.c_int,c.c_uint64,c.c_void_p,c.c_uint64,c.c_int,c.c_int,c.c_uint64,u64p,u64p,u64p]
decoder.IEWebPDecodeRGBA.restype = c.c_int
bridge.IEWebPDecodeToFile.argtypes = [c.c_int,c.c_uint64,c.c_int,c.c_int,c.c_int,c.c_uint64,c.c_uint64,u64p,u64p,u64p,u64p,u64p]
bridge.IEWebPDecodeToFile.restype = c.c_int
assert bridge.IEWebPOutputABIVersion() == decoder.IEWebPABIVersion() == 1
decode_pointer = c.cast(decoder.IEWebPDecodeRGBA,c.c_void_p).value
budget = 128 * 1024 * 1024
page = os.sysconf('SC_PAGE_SIZE')
fixtures = [
    ('white-lossy.webp',16,16),
    ('alpha-lossless.webp',3,2),
    ('alpha-lossy.webp',3,2),
    ('normal-webp-lossless.webp',2048,2048),
    ('normal-webp-lossy.webp',2048,2048),
    ('max-webp-lossless.webp',5000,5000),
    ('max-webp-lossy.webp',5000,5000),
]

def sha_file(fd):
    digest = hashlib.sha256()
    offset = 0
    while True:
        block = os.pread(fd,65536,offset)
        if not block:
            break
        digest.update(block)
        offset += len(block)
    return digest.hexdigest()

def run(path,width,height,limit=budget,expected_status=0):
    source = os.open(path,os.O_RDONLY)
    target = -1
    try:
        info = os.fstat(source)
        output_bytes = width*height*4
        with tempfile.TemporaryDirectory(prefix='ie-webp-output-') as directory:
            output_path = Path(directory)/'pixels'
            target = os.open(output_path,os.O_RDWR|os.O_CREAT|os.O_EXCL,0o600)
            os.lseek(source,min(info.st_size,2),os.SEEK_SET)
            os.lseek(target,1,os.SEEK_SET)
            peak,remaining,denied,mapped,live = [c.c_uint64() for _ in range(5)]
            status = bridge.IEWebPDecodeToFile(source,info.st_size,target,width,height,limit,decode_pointer,
                c.byref(peak),c.byref(remaining),c.byref(denied),c.byref(mapped),c.byref(live))
            assert status == expected_status,(path.name,status,expected_status)
            assert remaining.value == 0 and live.value == 0
            assert peak.value <= limit
            assert mapped.value in [0,(output_bytes+page-1)//page*page]
            assert os.lseek(source,0,os.SEEK_CUR) == min(info.st_size,2)
            assert os.lseek(target,0,os.SEEK_CUR) == 1
            pixels_hash = None
            if status == 0:
                os.fsync(target)
                assert os.fstat(target).st_size == output_bytes
                pixels_hash = sha_file(target)
                # The exact old ABI is the reference for transport equivalence.
                # It has a separate complete C lifetime and mapped output.
                with mmap.mmap(-1,output_bytes) as reference:
                    holder = (c.c_ubyte*output_bytes).from_buffer(reference)
                    reference_status = decoder.IEWebPDecodeRGBA(source,info.st_size,c.addressof(holder),
                        output_bytes,width,height,budget,c.byref(peak),c.byref(remaining),c.byref(denied))
                    assert reference_status == 0 and remaining.value == 0
                    assert hashlib.sha256(reference).hexdigest() == pixels_hash
                    del holder
            else:
                assert os.fstat(target).st_size == 0
            os.close(target);target = -1
        return {'file':path.name,'dimensions':[width,height],'status':status,'rgbaSHA256':pixels_hash,
                'outputMapped':mapped.value,'outputRemaining':live.value,'nativeRemaining':remaining.value}
    finally:
        if target >= 0:
            os.close(target)
        os.close(source)

results = [run(root/'tests/raster/fixtures'/name,width,height) for name,width,height in fixtures]
refusal = run(root/'tests/raster/fixtures/alpha-lossless.webp',3,2,limit=0,expected_status=3)
retry = run(root/'tests/raster/fixtures/alpha-lossless.webp',3,2)
# Two consecutive maximum imports verify mapping release and repeatable pixels;
# this is native lifecycle evidence, not a complete process RSS campaign.
repeated = [run(root/'tests/raster/fixtures/max-webp-lossless.webp',5000,5000) for _ in range(2)]
print(json.dumps({'status':'passed','fixtures':results,'refusal':refusal,'retry':retry,'repeated':repeated},sort_keys=True))
