#ifndef IDEOGRAM_WEBP_OUTPUT_H
#define IDEOGRAM_WEBP_OUTPUT_H
#include <stdint.h>
#if defined(__GNUC__)
#define IE_WEBP_OUTPUT_API __attribute__((visibility("default")))
#else
#define IE_WEBP_OUTPUT_API
#endif
#ifdef __cplusplus
extern "C" {
#endif

IE_WEBP_OUTPUT_API uint32_t IEWebPOutputABIVersion(void);

/* The caller owns all descriptors, small argument buffers and verified native
 * libraries for the entire synchronous call. No pointer or native handle escapes.
 * The target must be an owned regular, singly linked 0600 file opened O_RDWR.
 * Decode additionally requires an empty target and a distinct regular source.
 * Decoder status 0..6 is retained; 7 means target I/O/cleanup failure and 8 means
 * descriptor/source identity failure. Discard the target on every failure.
 * Pixels use one anonymous private mapping; checked <=64 KiB pread/pwrite calls
 * move bytes between that mapping and the owned file. A full disk is an I/O
 * refusal, not a file-mapping SIGBUS. Mapping metrics count the whole page-rounded
 * extent; remaining is zero only
 * after successful munmap. Failure to unmap leaves the bridge lease closed.
 * These calls never close, fsync or unlink a caller-owned descriptor. */
IE_WEBP_OUTPUT_API int IEWebPDecodeToFile(
    int source_fd, uint64_t input_bytes, int target_fd, int width, int height,
    uint64_t budget, uint64_t decoder_function,
    uint64_t* peak, uint64_t* remaining, uint64_t* denied,
    uint64_t* output_peak, uint64_t* output_remaining);

/* platform_kind 1 invokes sealed IEWebPConvertP3RGBA (six CMM functions).
 * platform_kind 2 invokes sealed IELinuxColorConvertRGBA (ten vips functions).
 * The caller verifies the exact profiles and function/library identities before
 * passing them. The existing converter's result 0..4 is retained, plus 7/8 above.
 * File size must already equal raw_bytes (positive RGBA multiple, <=25 MP). */
IE_WEBP_OUTPUT_API int IEWebPConvertFileRGBA(
    int fd, uint64_t raw_bytes, uint32_t platform_kind,
    const uint8_t* p3, uint32_t p3_bytes,
    const uint8_t* srgb, uint32_t srgb_bytes,
    const uint64_t* function_table, uint32_t function_count,
    uint64_t converter_function,
    uint64_t* output_peak, uint64_t* output_remaining);

#ifdef __cplusplus
}
#endif
#endif
