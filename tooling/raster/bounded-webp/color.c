#include "color.h"
#include <stdatomic.h>
#include <stddef.h>
#include <stdbool.h>

/* Public LCMS2 declarations, not private implementation entry points.
 * https://github.com/mm2/Little-CMS/blob/master/include/lcms2.h
 * The exact library implementing these is independently sealed by CODECS.
 * Passing its resolved functions avoids any additional native dependency. */
typedef int (*CMMVersion)(void);
typedef void* (*OpenProfile)(const void*, uint32_t);
typedef void* (*CreateTransform)(void*, uint32_t, void*, uint32_t, uint32_t, uint32_t);
typedef void (*DoTransform)(void*, const void*, void*, uint32_t);
typedef void (*DeleteTransform)(void*);
typedef int (*CloseProfile)(void*);
_Static_assert(sizeof(void*) == sizeof(uint64_t), "Qualified 64-bit pointer ABI required");

static atomic_bool active = ATOMIC_VAR_INIT(false);
enum { STRIP_PIXELS = 16384, TYPE_RGB8 = (4 << 16) | (3 << 3) | 1,
       FLAGS_NOCACHE = 0x0040 };

int IEWebPConvertP3RGBA(uint8_t* rgba, uint64_t rgba_size,
                      const uint8_t* p3, uint32_t p3_size,
                      const uint8_t* srgb, uint32_t srgb_size,
                      const uint64_t* functions, uint32_t function_count) {
  if (!rgba || rgba_size == 0 || rgba_size > 100000000 || rgba_size % 4 != 0 ||
      !p3 || p3_size != 480 || !srgb || srgb_size != 480 ||
      !functions || function_count != 6) return 2;
  for (uint32_t i = 0; i < function_count; ++i) if (!functions[i]) return 2;
  bool expected = false;
  if (!atomic_compare_exchange_strong(&active, &expected, true)) return 1;
  int status = 3;
  void* input = NULL; void* output = NULL; void* transform = NULL;
  CMMVersion version = (CMMVersion)(uintptr_t)functions[0];
  OpenProfile open_profile = (OpenProfile)(uintptr_t)functions[1];
  CreateTransform create_transform = (CreateTransform)(uintptr_t)functions[2];
  DoTransform do_transform = (DoTransform)(uintptr_t)functions[3];
  DeleteTransform delete_transform = (DeleteTransform)(uintptr_t)functions[4];
  CloseProfile close_profile = (CloseProfile)(uintptr_t)functions[5];
  if (version() != 2190) { status = 4; goto cleanup; }
  input = open_profile(p3, p3_size); output = open_profile(srgb, srgb_size);
  if (!input || !output) goto cleanup;
  /* Perceptual intent0 and NOCACHE match libvips. Both profiles and their
   * constant-size LUT allocations belong entirely to this C call. */
  transform = create_transform(input, TYPE_RGB8, output, TYPE_RGB8, 0, FLAGS_NOCACHE);
  if (!transform) goto cleanup;
  {
    uint8_t packed[STRIP_PIXELS * 3], converted[STRIP_PIXELS * 3];
    for (uint64_t start = 0; start < rgba_size; start += STRIP_PIXELS * 4) {
      uint64_t remaining = (rgba_size - start) / 4;
      uint32_t count = (uint32_t)(remaining < STRIP_PIXELS ? remaining : STRIP_PIXELS);
      for (uint32_t i = 0; i < count; ++i) {
        uint64_t at = start + (uint64_t)i * 4; uint32_t into = i * 3;
        packed[into] = rgba[at]; packed[into + 1] = rgba[at + 1]; packed[into + 2] = rgba[at + 2];
      }
      do_transform(transform, packed, converted, count);
      for (uint32_t i = 0; i < count; ++i) {
        uint64_t at = start + (uint64_t)i * 4; uint32_t from = i * 3;
        rgba[at] = converted[from]; rgba[at + 1] = converted[from + 1]; rgba[at + 2] = converted[from + 2];
      }
    }
  }
  status = 0;
cleanup:
  if (transform) delete_transform(transform);
  if (input) close_profile(input);
  if (output) close_profile(output);
  atomic_store(&active, false);
  return status;
}
