#include "color.h"
#include <stdatomic.h>
#include <stdbool.h>
#include <stddef.h>

/* Opaque public libvips 8.18.6 / GLib ABI declarations. No VipsImage layout or
 * private LCMS symbols are accessed. Exact implementing library and P3 bytes
 * are independently checked by the caller against the platform CODECS seal.
 * Sources: libvips/include/vips/{image,header,colour,vips}.h at v8.18.6. */
typedef void* (*NewMemory)(const void*, size_t, int, int, int, int);
typedef void (*SetBlob)(void*, const char*, const void*, size_t);
typedef int (*IccTransform)(void*, void**, const char*, ...);
typedef void* (*WriteMemory)(void*, size_t*);
typedef void (*Release)(void*);
typedef void (*ClearError)(void);
typedef int (*GetInt)(void);
typedef int (*Version)(int);
_Static_assert(sizeof(void*) == sizeof(uint64_t), "Qualified 64-bit pointer ABI required");
static atomic_bool active = ATOMIC_VAR_INIT(false);
enum { STRIP_PIXELS = 16384, FUNCTION_COUNT = 10 };
uint32_t IELinuxColorABIVersion(void) { return 1; }

int IELinuxColorConvertRGBA(uint8_t* rgba, uint64_t rgba_size,
  const uint8_t* p3, uint32_t p3_size, const uint64_t* functions,
  uint32_t function_count) {
  if (!rgba || !rgba_size || rgba_size > 100000000 || rgba_size % 4 ||
      !p3 || p3_size != 480 || !functions || function_count != FUNCTION_COUNT) return 2;
  for (uint32_t i=0; i<FUNCTION_COUNT; ++i) if (!functions[i]) return 2;
  bool expected = false;
  if (!atomic_compare_exchange_strong(&active, &expected, true)) return 1;
  NewMemory new_memory = (NewMemory)(uintptr_t)functions[0];
  SetBlob set_blob = (SetBlob)(uintptr_t)functions[1];
  IccTransform icc_transform = (IccTransform)(uintptr_t)functions[2];
  WriteMemory write_memory = (WriteMemory)(uintptr_t)functions[3];
  Release unref = (Release)(uintptr_t)functions[4];
  Release release_memory = (Release)(uintptr_t)functions[5];
  ClearError clear_error = (ClearError)(uintptr_t)functions[6];
  GetInt cache_max = (GetInt)(uintptr_t)functions[7];
  GetInt concurrency = (GetInt)(uintptr_t)functions[8];
  Version version = (Version)(uintptr_t)functions[9];
  int status = 4;
  void* input = NULL; void* output = NULL; uint8_t* converted = NULL;
  uint8_t packed[STRIP_PIXELS*3];
  /* Operations must never enter the process cache: it would retain stack-backed
   * input after this call. The existing raster worker configures these settings
   * before opening this bridge. We only check; never change shared globals. */
  if (version(0)!=8 || version(1)!=18 || version(2)!=6 ||
      cache_max()!=0 || concurrency()!=1) goto cleanup;
  status = 3;
  {
    for (uint64_t start=0; start<rgba_size; start+=STRIP_PIXELS*4) {
      uint64_t left=(rgba_size-start)/4;
      uint32_t count=(uint32_t)(left<STRIP_PIXELS ? left : STRIP_PIXELS);
      for (uint32_t i=0; i<count; ++i) {
        uint64_t at=start+(uint64_t)i*4; uint32_t into=i*3;
        packed[into]=rgba[at]; packed[into+1]=rgba[at+1]; packed[into+2]=rgba[at+2];
      }
      /* UCHAR=0, three RGB bands, height1. ICC operations use RGB_8 with
       * perceptual intent and CMS_FLAGS_NOCACHE in this sealed libvips. */
      input=new_memory(packed,(size_t)count*3,(int)count,1,3,0);
      if (!input) goto cleanup;
      set_blob(input,"icc-profile-data",p3,p3_size);
      if (icc_transform(input,&output,"srgb","embedded",1,"intent",0,
                        "depth",8,(const char*)NULL)) goto cleanup;
      if (!output) goto cleanup;
      size_t size=0;
      converted=write_memory(output,&size);
      if (!converted || size!=(size_t)count*3) goto cleanup;
      for (uint32_t i=0; i<count; ++i) {
        uint64_t at=start+(uint64_t)i*4; uint32_t from=i*3;
        rgba[at]=converted[from]; rgba[at+1]=converted[from+1]; rgba[at+2]=converted[from+2];
      }
      release_memory(converted); converted=NULL;
      unref(output); output=NULL;
      unref(input); input=NULL;
    }
  }
  status=0;
cleanup:
  if (converted) release_memory(converted);
  if (output) unref(output);
  if (input) unref(input);
  if (status==3) clear_error();
  atomic_store(&active,false);
  return status;
}
