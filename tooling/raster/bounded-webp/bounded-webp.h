#ifndef IDEOGRAM_BOUNDED_WEBP_H
#define IDEOGRAM_BOUNDED_WEBP_H
#include <stdint.h>
#if defined(__GNUC__)
#define IE_WEBP_API __attribute__((visibility("default")))
#else
#define IE_WEBP_API
#endif
#ifdef __cplusplus
extern "C" {
#endif
IE_WEBP_API uint32_t IEWebPABIVersion(void);
IE_WEBP_API uint32_t IEWebPDecoderVersion(void);
/* One active decoder per loaded library. Budget includes every codec heap
 * allocation, exact 16 KiB mapping rounding, private headers, and 64 bytes per block.
 * Caller-owned output/input buffers and process/runtime memory are separate.
 * creation_status: 0 success, 1 active/busy, 2 invalid, 3 allocation failure. */
IE_WEBP_API void* IEWebPNewRGBA(uint8_t* output, uint64_t output_size,
                              int output_stride, uint64_t budget,
                              int* creation_status);
/* Upstream VP8StatusCode, or -1 for an invalid handle/concurrent call. */
IE_WEBP_API int IEWebPAppend(void* decoder, const uint8_t* data, uint64_t size);
IE_WEBP_API uint8_t* IEWebPGetRGB(void* decoder, int* last_y, int* width,
                               int* height, int* stride);
IE_WEBP_API int IEWebPStats(void* decoder, uint64_t* budget, uint64_t* live,
                          uint64_t* peak, uint64_t* denied);
/* Returns 1 only after all codec allocations are freed; 0 means invalid/busy
 * or a retained allocation. In the last case the lease stays closed. */
IE_WEBP_API int IEWebPDelete(void* decoder, uint64_t* peak,
                           uint64_t* remaining, uint64_t* denied);
/* Preferred worker API: a complete decode and cleanup inside one native call.
 * Reads input_size bytes at offset zero using pread; fd position is unchanged.
 * Output is straight, non-premultiplied RGBA. Discard output on any failure.
 * 0 success, 1 busy, 2 invalid argument, 3 allocation failure, 4 invalid stream,
 * 5 I/O failure, 6 dimension mismatch. Stats are final after cleanup. */
IE_WEBP_API int IEWebPDecodeRGBA(int fd, uint64_t input_size, uint8_t* output,
                               uint64_t output_size, int width, int height,
                               uint64_t budget, uint64_t* peak,
                               uint64_t* remaining, uint64_t* denied);
#ifdef __cplusplus
}
#endif
#endif
