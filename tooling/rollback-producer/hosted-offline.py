#!/usr/bin/env python3
"""Fixed inherited socket policy for native offline verification only.

No installation occurs on import. This does not replace the fresh network
namespace, identity/descriptor checks, or the sealed producer namespace filter.
"""
import ctypes
import errno
import hashlib
import json
import platform
import re
import struct
import sys

POLICY = 'hosted-native-offline-stream-ipc-1'
ARCH = 0xc000003e  # AUDIT_ARCH_X86_64; no compatibility/x32 execution.
KILL = 0x80000000
DENY = 0x00050000 | errno.EPERM
ALLOW = 0x7fff0000


def require(value, message):
    if not value: raise ValueError(message)


def program():
    # seccomp_data: nr@0, arch@4, six u64 arguments starting @16.
    code = [(0x20,0,0,4),(0x15,1,0,ARCH),(0x06,0,0,KILL),
            (0x20,0,0,0),(0x35,0,1,0x40000000),(0x06,0,0,KILL)]
    # socket, connect, and all io_uring entry points.
    for number in (41,42,425,426,427): code += [(0x15,0,1,number),(0x06,0,0,DENY)]
    code += [(0x15,1,0,53),(0x06,0,0,ALLOW)]  # socketpair only below.
    for offset, value in ((16,1),(20,0)):
        code += [(0x20,0,0,offset),(0x15,1,0,value),(0x06,0,0,DENY)]
    code += [(0x20,0,0,24),(0x54,0,0,(~(0x80000|0x800)) & 0xffffffff),
             (0x15,1,0,1),(0x06,0,0,DENY)]
    for offset in (28,32,36):
        code += [(0x20,0,0,offset),(0x15,1,0,0),(0x06,0,0,DENY)]
    return [*code,(0x06,0,0,ALLOW)]


def description():
    instructions=program(); encoded=b''.join(struct.pack('<HBBI',*row) for row in instructions)
    return {'policy':POLICY,'architecture':'x86_64','sha256':hashlib.sha256(encoded).hexdigest(),'instructions':instructions}


def install():
    require(sys.platform=='linux' and platform.machine()=='x86_64' and sys.byteorder=='little' and struct.calcsize('P')==8,'Offline filter requires Linux little-endian x86_64 LP64')
    release=re.match(r'([0-9]+)\.([0-9]+)',platform.release())
    require(release is not None and tuple(map(int,release.groups()))>=(5,4),'Offline filter requires kernel 5.4 or newer')
    class Filter(ctypes.Structure): _fields_=[('code',ctypes.c_ushort),('jt',ctypes.c_ubyte),('jf',ctypes.c_ubyte),('k',ctypes.c_uint32)]
    class Program(ctypes.Structure): _fields_=[('len',ctypes.c_ushort),('filter',ctypes.POINTER(Filter))]
    rows=program(); instructions=(Filter*len(rows))(*(Filter(*row) for row in rows)); value=Program(len(rows),instructions)
    libc=ctypes.CDLL(None,use_errno=True); call=libc.prctl
    call.argtypes=[ctypes.c_int,ctypes.c_ulong,ctypes.c_ulong,ctypes.c_ulong,ctypes.c_ulong];call.restype=ctypes.c_int
    def prctl(option,arg=0):
        result=call(option,arg,0,0,0);require(result>=0,'Offline prctl failed, errno='+str(ctypes.get_errno()));return result
    require(prctl(39)==1,'Fixed privilege drop must set no-new-privileges before filter')
    # PR_SET_SECCOMP takes the mode and pointer as two distinct arguments.
    require(call(22,2,ctypes.addressof(value),0,0)==0,'Offline socket filter installation failed, errno='+str(ctypes.get_errno()))
    require(prctl(21)==2 and prctl(39)==1,'Offline filter/no-new-privileges readback failed')
    result=description();result.pop('instructions');return {**result,'installed':True,'inheritedAcrossExec':True,'physicalQualification':False}

if __name__=='__main__':
    # Data-only test interface. It cannot install a policy or execute a command.
    require(sys.argv[1:]==['--describe'] and sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode and not sys.flags.optimize,'Only isolated --describe is public')
    print(json.dumps(description(),sort_keys=True,separators=(',',':')))
