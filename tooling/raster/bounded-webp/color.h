#ifndef IDEOGRAM_BOUNDED_WEBP_COLOR_H
#define IDEOGRAM_BOUNDED_WEBP_COLOR_H
#include "bounded-webp.h"
#ifdef __cplusplus
extern "C" {
#endif
/* Qualified LCMS2 RGB8 conversion inside one native call. The caller verifies
 * exact sealed P3/sRGB ICC identities and owns every passed buffer and the
 * library containing the function table throughout this call.
 * Six uint64 function addresses, in order: cmsGetEncodedCMMversion,
 * cmsOpenProfileFromMem, cmsCreateTransform, cmsDoTransform,
 * cmsDeleteTransform, cmsCloseProfile. The qualified ABI is 64-bit.
 * Only RGB bytes are rewritten; straight alpha never changes and RGB is
 * converted even at zero alpha.
 * Scratch is two fixed 49,152-byte RGB blocks. LCMS allocations depend only on
 * the two fixed profiles and are separate from the WebP decoder's allocation
 * cap. Every LCMS handle is closed before returning, even on failure.
 * 0 success, 1 busy, 2 invalid argument, 3 profile/transform allocation failure,
 * 4 incompatible LCMS ABI. Discard output on every failure. */
IE_WEBP_API int IEWebPConvertP3RGBA(uint8_t* rgba, uint64_t rgba_size,
                                 const uint8_t* p3, uint32_t p3_size,
                                 const uint8_t* srgb, uint32_t srgb_size,
                                 const uint64_t* functions,
                                 uint32_t function_count);
#ifdef __cplusplus
}
#endif
#endif
