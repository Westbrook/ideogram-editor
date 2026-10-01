/* Ideogram Editor's allocator and narrow ABI for unchanged libwebp 1.6.0.
 * Single active decoder, and no concurrent upstream calls, per loaded dylib.
 * Native allocations are bounded; this is not a process RSS measurement. */
#include "bounded-webp.h"
#include <limits.h>
#include <errno.h>
#include <unistd.h>
#include <stddef.h>
#include <stdint.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#ifdef IE_WEBP_TEST_ALLOCATIONS
#include <stdio.h>
#endif
#include "src/webp/decode.h"

#if !defined(__linux__) || !(defined(__aarch64__) || defined(__x86_64__))
#error This producer requires a separately sealed Linux arm64 or x64 build.
#endif
#if defined(WEBP_USE_THREAD) || defined(HAVE_CONFIG_H)
#error Upstream threading/configuration must be disabled.
#endif

#define IE_ALLOCATION_ALLOWANCE ((size_t)64)
#define IE_ALLOCATION_GRANULARITY ((size_t)16384)
#define IE_ALLOCATION_MAGIC UINT64_C(0x494557454250414c)
typedef union IEAllocationHeader {
  max_align_t alignment;
  struct { size_t charged; size_t mapped; size_t payload; uint64_t magic; } value;
} IEAllocationHeader;
_Static_assert(sizeof(IEAllocationHeader) % _Alignof(max_align_t) == 0,
               "Allocation header must preserve maximum C alignment");
_Static_assert(sizeof(size_t) == sizeof(uint64_t), "64-bit allocation ABI");

static atomic_flag call_lock = ATOMIC_FLAG_INIT;
static WebPIDecoder* active = NULL;
static int lease = 0;
static size_t allocation_limit = 0;
static size_t allocation_live = 0;
static size_t allocation_peak = 0;
static uint64_t allocation_denied = 0;

static int Enter(void) {
  return !atomic_flag_test_and_set_explicit(&call_lock, memory_order_acquire);
}
static void Leave(void) {
  atomic_flag_clear_explicit(&call_lock, memory_order_release);
}
static void Denied(void) {
  if (allocation_denied != UINT64_MAX) ++allocation_denied;
}

/* These functions are hidden and reachable only while a guarded IE operation
 * is running. All upstream translation units substitute their libc allocators. */
static int CompatiblePageSize(void) {
  const long size = sysconf(_SC_PAGESIZE);
  return size > 0 && (size_t)size <= IE_ALLOCATION_GRANULARITY &&
         IE_ALLOCATION_GRANULARITY % (size_t)size == 0;
}

void* IEWebPBoundedMalloc(size_t payload) {
  if (!lease || payload > SIZE_MAX - sizeof(IEAllocationHeader) -
                          (IE_ALLOCATION_GRANULARITY - 1)) {
    Denied(); return NULL;
  }
  const size_t needed = payload + sizeof(IEAllocationHeader);
  const size_t mapped = (needed + IE_ALLOCATION_GRANULARITY - 1) &
                       ~(IE_ALLOCATION_GRANULARITY - 1);
  if (mapped > SIZE_MAX - IE_ALLOCATION_ALLOWANCE) { Denied(); return NULL; }
  const size_t charged = mapped + IE_ALLOCATION_ALLOWANCE;
#ifdef IE_WEBP_TEST_ALLOCATIONS
  if (payload > 1024 * 1024) fprintf(stderr, "allocation payload=%zu mapped=%zu live=%zu limit=%zu\n", payload, mapped, allocation_live, allocation_limit);
#endif
  if (allocation_live > allocation_limit ||
      charged > allocation_limit - allocation_live) {
    Denied(); return NULL;
  }
  /* Reserve exact page-rounded mapping bytes before entering the kernel.
   * mmap avoids malloc cache reuse whose actual size can exceed good_size. */
  allocation_live += charged;
  IEAllocationHeader* header = (IEAllocationHeader*)mmap(NULL, mapped,
      PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
  if (header == MAP_FAILED) {
    allocation_live -= charged; Denied(); return NULL;
  }
  header->value.charged = charged;
  header->value.mapped = mapped;
  header->value.payload = payload;
  header->value.magic = IE_ALLOCATION_MAGIC;
  if (allocation_live > allocation_peak) allocation_peak = allocation_live;
  return header + 1;
}

void IEWebPBoundedFree(void* ptr) {
  if (ptr == NULL) return;
  IEAllocationHeader* header = (IEAllocationHeader*)ptr - 1;
  if (header->value.magic != IE_ALLOCATION_MAGIC ||
      header->value.charged > allocation_live) abort();
  const size_t charged = header->value.charged;
  const size_t mapped = header->value.mapped;
  if (mapped == 0 || mapped % IE_ALLOCATION_GRANULARITY != 0 ||
      charged != mapped + IE_ALLOCATION_ALLOWANCE) abort();
  header->value.magic = 0;
  if (munmap(header, mapped) != 0) abort(); /* Never debit an unreleased mapping. */
  allocation_live -= charged;
}

void* IEWebPBoundedCalloc(size_t count, size_t size) {
  if (size != 0 && count > SIZE_MAX / size) { Denied(); return NULL; }
  const size_t bytes = count * size;
  void* result = IEWebPBoundedMalloc(bytes);
  if (result != NULL) memset(result, 0, bytes);
  return result;
}

void* IEWebPBoundedRealloc(void* ptr, size_t size) {
  if (ptr == NULL) return IEWebPBoundedMalloc(size);
  if (size == 0) { IEWebPBoundedFree(ptr); return NULL; }
  IEAllocationHeader* header = (IEAllocationHeader*)ptr - 1;
  if (header->value.magic != IE_ALLOCATION_MAGIC) abort();
  void* result = IEWebPBoundedMalloc(size);
  if (result == NULL) return NULL;
  memcpy(result, ptr, size < header->value.payload ? size : header->value.payload);
  IEWebPBoundedFree(ptr);
  return result;
}

uint32_t IEWebPABIVersion(void) { return 1; }
uint32_t IEWebPDecoderVersion(void) { return (uint32_t)WebPGetDecoderVersion(); }

void* IEWebPNewRGBA(uint8_t* output, uint64_t output_size, int output_stride,
                  uint64_t budget, int* creation_status) {
  if (creation_status != NULL) *creation_status = 1;
  if (!Enter()) return NULL;
  if (lease || allocation_live != 0) { Leave(); return NULL; }
  if (output == NULL || output_size == 0 || output_size > SIZE_MAX ||
      output_stride <= 0 || budget > SIZE_MAX || !CompatiblePageSize()) {
    if (creation_status != NULL) *creation_status = 2;
    Leave(); return NULL;
  }
  lease = 1;
  allocation_limit = (size_t)budget;
  allocation_live = allocation_peak = 0;
  allocation_denied = 0;
  active = WebPINewRGB(MODE_RGBA, output, (size_t)output_size, output_stride);
  if (active == NULL) {
    if (allocation_live == 0) lease = 0;
    if (creation_status != NULL) *creation_status = 3;
  } else if (creation_status != NULL) {
    *creation_status = 0;
  }
  void* result = active;
  Leave(); return result;
}

int IEWebPAppend(void* decoder, const uint8_t* data, uint64_t size) {
  if (!Enter()) return -1;
  if (decoder == NULL || decoder != active || size > SIZE_MAX || data == NULL) {
    Leave(); return -1;
  }
  const int result = (int)WebPIAppend(active, data, (size_t)size);
  Leave(); return result;
}

uint8_t* IEWebPGetRGB(void* decoder, int* last_y, int* width, int* height,
                    int* stride) {
  if (!Enter()) return NULL;
  if (decoder == NULL || decoder != active) { Leave(); return NULL; }
  uint8_t* result = WebPIDecGetRGB(active, last_y, width, height, stride);
  Leave(); return result;
}

int IEWebPStats(void* decoder, uint64_t* budget, uint64_t* live,
               uint64_t* peak, uint64_t* denied) {
  if (!Enter()) return 0;
  if (decoder == NULL || decoder != active) { Leave(); return 0; }
  if (budget != NULL) *budget = allocation_limit;
  if (live != NULL) *live = allocation_live;
  if (peak != NULL) *peak = allocation_peak;
  if (denied != NULL) *denied = allocation_denied;
  Leave(); return 1;
}

int IEWebPDelete(void* decoder, uint64_t* peak, uint64_t* remaining,
                uint64_t* denied) {
  if (!Enter()) return 0;
  if (decoder == NULL || decoder != active) { Leave(); return 0; }
  WebPIDelete(active);
  active = NULL;
  if (peak != NULL) *peak = allocation_peak;
  if (remaining != NULL) *remaining = allocation_live;
  if (denied != NULL) *denied = allocation_denied;
  const int released = allocation_live == 0;
  if (released) lease = 0;
  Leave(); return released;
}

int IEWebPDecodeRGBA(int fd, uint64_t input_size, uint8_t* output,
                    uint64_t output_size, int width, int height,
                    uint64_t budget, uint64_t* peak,
                    uint64_t* remaining, uint64_t* denied) {
  if (peak != NULL) *peak = 0;
  if (remaining != NULL) *remaining = 0;
  if (denied != NULL) *denied = 0;
  if (!Enter()) return 1;
  if (lease || allocation_live != 0) { Leave(); return 1; }
  if (fd < 0 || input_size == 0 || input_size > INT64_MAX || output == NULL ||
      width <= 0 || height <= 0 || width > INT_MAX / 4 ||
      (uint64_t)width * (uint64_t)height > SIZE_MAX / 4 ||
      output_size < (uint64_t)width * (uint64_t)height * 4 ||
      output_size > SIZE_MAX || budget > SIZE_MAX || !CompatiblePageSize()) { Leave(); return 2; }
  lease = 1;
  allocation_limit = (size_t)budget;
  allocation_live = allocation_peak = 0;
  allocation_denied = 0;
  int result = 0;
  active = WebPINewRGB(MODE_RGBA, output, (size_t)output_size, width * 4);
  if (active == NULL) {
    result = 3;
  } else {
    uint8_t input[65536];
    uint64_t offset = 0;
    VP8StatusCode status = VP8_STATUS_SUSPENDED;
    while (offset < input_size) {
      const size_t wanted = input_size - offset < sizeof(input)
          ? (size_t)(input_size - offset) : sizeof(input);
      ssize_t received;
      do {
        received = pread(fd, input, wanted, (off_t)offset);
      } while (received < 0 && errno == EINTR);
      if (received <= 0) { result = 5; break; }
      offset += (uint64_t)received;
      status = WebPIAppend(active, input, (size_t)received);
      if (status != VP8_STATUS_OK && status != VP8_STATUS_SUSPENDED) {
        result = status == VP8_STATUS_OUT_OF_MEMORY ? 3 : 4;
        break;
      }
    }
    if (result == 0 && status != VP8_STATUS_OK) result = 4;
    if (result == 0) {
      int last_y = 0, actual_width = 0, actual_height = 0, stride = 0;
      const uint8_t* decoded = WebPIDecGetRGB(active, &last_y, &actual_width,
                                             &actual_height, &stride);
      if (decoded != output || actual_width != width || actual_height != height ||
          last_y != height || stride != width * 4) result = 6;
    }
    WebPIDelete(active);
    active = NULL;
  }
  if (peak != NULL) *peak = allocation_peak;
  if (remaining != NULL) *remaining = allocation_live;
  if (denied != NULL) *denied = allocation_denied;
  if (allocation_live == 0) lease = 0;
  else result = 3;  /* Any leak fails closed for the lifetime of this library. */
  Leave(); return result;
}
