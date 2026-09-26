# Independent public LittleCMS C interface, no Sharp or application raster code.
# TYPE_RGB_8 = COLORSPACE_SH(PT_RGB=4) | CHANNELS_SH(3) | BYTES_SH(1).
import ctypes as c,json,pathlib,hashlib
root=pathlib.Path(__file__).resolve().parents[2]
lib=c.CDLL(str(root/'node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.18.6.dylib'))
lib.cmsOpenProfileFromMem.argtypes=[c.c_void_p,c.c_uint32];lib.cmsOpenProfileFromMem.restype=c.c_void_p
lib.cmsCreateTransform.argtypes=[c.c_void_p,c.c_uint32,c.c_void_p,c.c_uint32,c.c_uint32,c.c_uint32];lib.cmsCreateTransform.restype=c.c_void_p
lib.cmsDoTransform.argtypes=[c.c_void_p,c.c_void_p,c.c_void_p,c.c_uint32]
lib.cmsDeleteTransform.argtypes=[c.c_void_p];lib.cmsCloseProfile.argtypes=[c.c_void_p]
p3=(root/'tooling/raster/p3.icc').read_bytes();srgb=(root/'tooling/raster/srgb.icc').read_bytes()
a=lib.cmsOpenProfileFromMem(p3,len(p3));b=lib.cmsOpenProfileFromMem(srgb,len(srgb));assert a and b
transform=lib.cmsCreateTransform(a,(4<<16)|(3<<3)|1,b,(4<<16)|(3<<3)|1,0,0);assert transform
source=bytes([128,64,32,100,150,200,220,120,90,40,80,140]);target=c.create_string_buffer(len(source));lib.cmsDoTransform(transform,source,target,len(source)//3)
lib.cmsDeleteTransform(transform);lib.cmsCloseProfile(a);lib.cmsCloseProfile(b)
print(json.dumps({'method':'Public LittleCMS C cmsCreateTransform/cmsDoTransform, TYPE_RGB_8, perceptual intent0, flags0; original fixture primaries and nonprimary colors. No Sharp/app calls.','sourceRGB':list(source),'expectedRGB':list(target.raw),'profileSHA256':{'p3':hashlib.sha256(p3).hexdigest(),'srgb':hashlib.sha256(srgb).hexdigest()}},indent=2))
