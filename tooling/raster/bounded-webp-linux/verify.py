"""Native ABI, allocation refusal, and differential tests; no application code.
Runs in separate processes for both dynamic-library load orders. All decode
pixels are compared with the existing sealed libwebp 1.6.0 C API, including
hidden RGB; it is a pinned-codec differential, not an independent algorithm.
"""
import ctypes as c
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
if len(sys.argv) < 4:
    raise SystemExit('Usage: verify.py BOUNDED_LIBRARY ORACLE_LIBRARY REPOSITORY_ROOT [LOAD_ORDER]')
NATIVE = Path(sys.argv[1]).resolve()
ORACLE = Path(sys.argv[2]).resolve()
ROOT = Path(sys.argv[3]).resolve()
if len(sys.argv) == 4:
    reports = [json.loads(subprocess.check_output([sys.executable, __file__, str(NATIVE), str(ORACLE), str(ROOT), order], text=True)) for order in ['oracle-first','bounded-first']]
    print(json.dumps({'status':'passed','oracle':'Unmodified libwebp1.6.0 built separately without allocation redirects; pinned-codec differential, not an independent implementation.', 'loadOrders':reports}, indent=2))
    raise SystemExit(0)
order = sys.argv[4]
if order == 'oracle-first':
    oracle = c.CDLL(str(ORACLE), mode=c.RTLD_GLOBAL)
    lib = c.CDLL(str(NATIVE), mode=c.RTLD_GLOBAL)
else:
    lib = c.CDLL(str(NATIVE), mode=c.RTLD_GLOBAL)
    oracle = c.CDLL(str(ORACLE), mode=c.RTLD_GLOBAL)
u64p = c.POINTER(c.c_uint64)
intp = c.POINTER(c.c_int)
lib.IEWebPDecodeRGBA.argtypes = [c.c_int,c.c_uint64,c.c_void_p,c.c_uint64,c.c_int,c.c_int,c.c_uint64,u64p,u64p,u64p]
lib.IEWebPDecodeRGBA.restype = c.c_int
lib.IEWebPNewRGBA.argtypes = [c.c_void_p,c.c_uint64,c.c_int,c.c_uint64,intp]
lib.IEWebPNewRGBA.restype = c.c_void_p
lib.IEWebPAppend.argtypes = [c.c_void_p,c.c_void_p,c.c_uint64]
lib.IEWebPAppend.restype = c.c_int
lib.IEWebPDelete.argtypes = [c.c_void_p,u64p,u64p,u64p]
lib.IEWebPDelete.restype = c.c_int
lib.IEWebPStats.argtypes = [c.c_void_p,u64p,u64p,u64p,u64p]
lib.IEWebPStats.restype = c.c_int
oracle.WebPGetInfo.argtypes = [c.c_void_p,c.c_size_t,intp,intp]
oracle.WebPGetInfo.restype = c.c_int
oracle.WebPDecodeRGBA.argtypes = [c.c_void_p,c.c_size_t,intp,intp]
oracle.WebPDecodeRGBA.restype = c.c_void_p
oracle.WebPFree.argtypes = [c.c_void_p]
assert lib.IEWebPABIVersion() == 1
assert lib.IEWebPDecoderVersion() == 0x010600
assert oracle.WebPGetDecoderVersion() == 0x010600
# Upstream symbols are absent from the new dylib's handle even with oracle global.
try:
    lib.WebPDecodeRGBA
    raise AssertionError('upstream WebP symbol escaped the wrapper')
except AttributeError:
    pass

def one(path, budget=128*1024*1024, dimensions=None, size_delta=0):
    data = path.read_bytes()
    width = c.c_int(); height = c.c_int()
    assert oracle.WebPGetInfo(data,len(data),c.byref(width),c.byref(height))
    w,h = dimensions or (width.value,height.value)
    size = w*h*4
    # Guard bytes prove that caller's region boundaries remain untouched.
    output = (c.c_ubyte*(size+128))()
    for i in range(64): output[i] = output[size+64+i] = 0xA7
    address = c.addressof(output)+64
    peak = c.c_uint64(); remaining = c.c_uint64(); denied = c.c_uint64()
    fd = os.open(path,os.O_RDONLY)
    try:
        os.lseek(fd, min(3,len(data)), os.SEEK_SET)
        prior_offset = os.lseek(fd,0,os.SEEK_CUR)
        status = lib.IEWebPDecodeRGBA(fd,len(data),address,size+size_delta,w,h,budget,c.byref(peak),c.byref(remaining),c.byref(denied))
        assert os.lseek(fd,0,os.SEEK_CUR) == prior_offset
    finally: os.close(fd)
    assert remaining.value == 0
    assert peak.value <= budget
    assert bytes(output[:64]) == b'\xa7'*64 and bytes(output[-64:]) == b'\xa7'*64
    if status == 0:
        ptr = oracle.WebPDecodeRGBA(data,len(data),c.byref(width),c.byref(height))
        assert ptr
        try:
            expected_hash = hashlib.sha256((c.c_ubyte*size).from_address(ptr)).hexdigest()
        finally: oracle.WebPFree(ptr)
        actual_hash = hashlib.sha256((c.c_ubyte*size).from_address(address)).hexdigest()
        assert actual_hash == expected_hash, path.name
    else:
        actual_hash = None
    return {'encodedSHA256':hashlib.sha256(data).hexdigest(),'file':path.name,'dimensions':[w,h],'status':status,'budget':budget,'peak':peak.value,'remaining':remaining.value,'denied':denied.value,'rgbaSHA256':actual_hash}

names = ['white-lossy.webp','alpha-lossless.webp','alpha-lossy.webp','normal-webp-lossless.webp','normal-webp-lossy.webp','max-webp-lossless.webp','max-webp-lossy.webp']
results = [one(ROOT/'tests/raster/fixtures'/name) for name in names]
assert all(row['status']==0 and row['denied']==0 for row in results), results
# Existing checked-in oracle bytes and independently calculable white output
# prevent a coincidentally matching pair of decoders from redefining the fixture.
alpha = json.loads((ROOT/'tests/raster/fixtures/webp-oracle.json').read_text())
for fixture in alpha['fixtures']:
    row = next(result for result in results if result['file'] == fixture['name'])
    assert row['encodedSHA256'] == fixture['encodedSHA256']
    assert row['rgbaSHA256'] == hashlib.sha256(bytes(fixture['expectedRGBA'])).hexdigest()
resources = json.loads((ROOT/'tests/raster/fixtures/resource-inputs.json').read_text())
for fixture in resources['fixtures']:
    if fixture['format'] != 'webp': continue
    row = next(result for result in results if result['file'] == Path(fixture['file']).name)
    assert row['encodedSHA256'] == fixture['sha256']
    digest = hashlib.sha256()
    remaining = fixture['width']*fixture['height']*4
    chunk = bytes([255])*65536
    while remaining:
        count = min(remaining,len(chunk)); digest.update(chunk[:count]); remaining -= count
    assert row['rgbaSHA256'] == digest.hexdigest()

small = ROOT/'tests/raster/fixtures/alpha-lossless.webp'
refusals = [one(small,budget=0),one(small,budget=4096),one(small,size_delta=-1)]
assert refusals[0]['status']==3
assert refusals[1]['status']==3 and refusals[1]['denied'] > 0
assert refusals[2]['status']==2
# A large decode is refused after earlier allocations, then a small decode works.
refusals.append(one(ROOT/'tests/raster/fixtures/max-webp-lossless.webp',budget=1024*1024))
assert refusals[-1]['status']==3 and refusals[-1]['denied']>0 and refusals[-1]['peak']>0
assert one(small)['status']==0
# The incremental ABI refuses active lease replacement without changing its cap.
output = (c.c_ubyte*64)(); status=c.c_int()
handle = lib.IEWebPNewRGBA(output,64,16,128*1024,c.byref(status))
assert handle and status.value==0
assert not lib.IEWebPNewRGBA(output,64,16,2**63,c.byref(status)) and status.value==1
limit=c.c_uint64();live=c.c_uint64();peak=c.c_uint64();denied=c.c_uint64()
assert lib.IEWebPStats(handle,c.byref(limit),c.byref(live),c.byref(peak),c.byref(denied))==1
assert limit.value==128*1024 and live.value>0
assert lib.IEWebPAppend(None,b'x',1)==-1
assert lib.IEWebPAppend(1,b'x',1)==-1
assert lib.IEWebPDelete(handle,c.byref(peak),c.byref(live),c.byref(denied))==1 and live.value==0
assert lib.IEWebPDelete(handle,None,None,None)==0
assert one(small)['status']==0
print(json.dumps({'order':order,'fixtures':results,'refusals':refusals,'leaseIsolation':'passed'}))
