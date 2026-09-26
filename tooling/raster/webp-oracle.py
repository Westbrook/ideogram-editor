# Public libwebp decoder interface, bypassing Sharp and the application engine.
import ctypes as c,json,pathlib,hashlib
root=pathlib.Path(__file__).resolve().parents[2];lib=c.CDLL(str(root/'node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.18.6.dylib'))
lib.WebPDecodeRGBA.argtypes=[c.c_void_p,c.c_size_t,c.POINTER(c.c_int),c.POINTER(c.c_int)];lib.WebPDecodeRGBA.restype=c.c_void_p;lib.WebPFree.argtypes=[c.c_void_p]
result=[]
for name in ['alpha-lossless.webp','alpha-lossy.webp']:
 data=(root/'tests/raster/fixtures'/name).read_bytes();w=c.c_int();h=c.c_int();p=lib.WebPDecodeRGBA(data,len(data),c.byref(w),c.byref(h));assert p
 rgba=c.string_at(p,w.value*h.value*4);lib.WebPFree(p);result.append({'name':name,'encodedSHA256':hashlib.sha256(data).hexdigest(),'width':w.value,'height':h.value,'expectedRGBA':list(rgba)})
print(json.dumps({'method':'Public libwebp1.6.0 WebPDecodeRGBA and WebPFree C APIs; no Sharp/application code. This is a pinned codec diagnostic, not a separate libwebp implementation qualification.','fixtures':result},indent=2))
