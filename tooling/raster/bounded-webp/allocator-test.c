/* A producer-only native test: include implementation to inspect invariants.
 * This executable is never shipped or used by the editor. */
#define IE_WEBP_TEST_ALLOCATIONS
#include "bounded-webp.c"
#include <fcntl.h>
#include <sys/stat.h>
#include <stdio.h>
#define CHECK(condition) do { if (!(condition)) { fprintf(stderr, "failed: %s at %d\n", #condition, __LINE__); return 1; } } while (0)
int main(int argc, char** argv) {
  if (argc == 2) {
    int fd = open(argv[1], O_RDONLY); struct stat info;
    CHECK(fd >= 0 && fstat(fd, &info) == 0);
    uint8_t* rgba = malloc(100000000); CHECK(rgba != NULL);
    for (int mib = 128; mib <= 384; mib += 32) {
      uint64_t peak = 0, remaining = 0, denied = 0;
      int status = IEWebPDecodeRGBA(fd, info.st_size, rgba, 100000000, 5000, 5000,
        (uint64_t)mib * 1024 * 1024, &peak, &remaining, &denied);
      fprintf(stderr, "capMiB=%d status=%d peak=%llu remaining=%llu denied=%llu\n",
        mib,status,(unsigned long long)peak,(unsigned long long)remaining,(unsigned long long)denied);
    }
    free(rgba); close(fd); return 0;
  }
  CHECK(IEWebPABIVersion() == 1);
  CHECK(IEWebPDecoderVersion() == 0x010600);
  lease = 1; allocation_limit = 65536;
  CHECK(IEWebPBoundedMalloc(SIZE_MAX) == NULL);
  CHECK(IEWebPBoundedCalloc(SIZE_MAX, 2) == NULL);
  CHECK(allocation_live == 0 && allocation_denied == 2);
  void* first = IEWebPBoundedMalloc(17);
  CHECK(first != NULL && (uintptr_t)first % _Alignof(max_align_t) == 0);
  CHECK(allocation_live >= 17 + sizeof(IEAllocationHeader) + IE_ALLOCATION_ALLOWANCE);
  const size_t charged = allocation_live;
  allocation_limit = charged;
  CHECK(IEWebPBoundedRealloc(first, 17) == NULL);
  CHECK(allocation_live == charged); /* Failed realloc preserves the old block. */
  allocation_limit = charged * 2;
  memset(first, 42, 17);
  void* second = IEWebPBoundedRealloc(first, 17);
  CHECK(second != NULL && allocation_peak == charged * 2);
  CHECK(allocation_live == charged && ((unsigned char*)second)[16] == 42);
  IEWebPBoundedFree(second);
  CHECK(allocation_live == 0);
  allocation_limit = SIZE_MAX; allocation_live = SIZE_MAX - 1;
  CHECK(IEWebPBoundedMalloc(1) == NULL); /* Live-sum overflow is refused. */
  allocation_live = 0;
  void* zeros = IEWebPBoundedCalloc(17, 3);
  CHECK(zeros != NULL);
  for (int i = 0; i < 51; ++i) CHECK(((unsigned char*)zeros)[i] == 0);
  CHECK(IEWebPBoundedRealloc(zeros, 0) == NULL && allocation_live == 0);
  lease = 0;
  unsigned char output[4] = {0}; int status = -1;
  CHECK(IEWebPNewRGBA(output, 4, 4, 0, &status) == NULL && status == 3);
  CHECK(allocation_live == 0 && lease == 0);
  void* decoder = IEWebPNewRGBA(output, 4, 4, 65536, &status);
  CHECK(decoder != NULL && status == 0);
  const size_t prior_live = allocation_live;
  CHECK(IEWebPNewRGBA(output, 4, 4, SIZE_MAX, &status) == NULL && status == 1);
  CHECK(allocation_limit == 65536 && allocation_live == prior_live);
  CHECK(IEWebPAppend(NULL, output, 4) == -1);
  CHECK(IEWebPAppend((void*)(uintptr_t)1, output, 4) == -1);
  CHECK(IEWebPDelete((void*)(uintptr_t)1, NULL, NULL, NULL) == 0);
  uint64_t peak = 0, remaining = 1, denied = 0;
  CHECK(IEWebPDelete(decoder, &peak, &remaining, &denied) == 1);
  CHECK(peak > 0 && remaining == 0 && denied == 0 && lease == 0);
  CHECK(IEWebPDelete(decoder, NULL, NULL, NULL) == 0);
  for (int i = 0; i < 100; ++i) {
    decoder = IEWebPNewRGBA(output, 4, 4, 65536, &status);
    CHECK(decoder != NULL && status == 0);
    CHECK(IEWebPDelete(decoder, &peak, &remaining, &denied) == 1);
    CHECK(remaining == 0);
  }
  puts("allocator invariants passed");
  return 0;
}
