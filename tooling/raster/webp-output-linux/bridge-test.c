/* Producer-only invariant tests. Real pixel parity is checked separately. */
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

static int fail_map, fail_unmap, fail_read, fail_write, interrupt_write, short_write;
static void* last_mapping;
static size_t last_mapping_bytes;
static void* TestMap(void* at, size_t length, int protection, int flags, int fd, off_t offset) {
  if (fail_map) { errno = ENOMEM; return MAP_FAILED; }
  void* result = mmap(at, length, protection, flags, fd, offset);
  if (result != MAP_FAILED) { last_mapping = result; last_mapping_bytes = length; }
  return result;
}
static int TestUnmap(void* at, size_t length) {
  if (fail_unmap) { errno = EINVAL; return -1; }
  return munmap(at, length);
}
static ssize_t TestRead(int fd, void* bytes, size_t count, off_t offset) {
  if (fail_read) { errno = EIO; return -1; }
  return pread(fd, bytes, count, offset);
}
static ssize_t TestWrite(int fd, const void* bytes, size_t count, off_t offset) {
  if (fail_write) { errno = ENOSPC; return -1; }
  if (interrupt_write) { interrupt_write = 0; errno = EINTR; return -1; }
  if (short_write && count > 1) count /= 2;
  return pwrite(fd, bytes, count, offset);
}
#define mmap TestMap
#define munmap TestUnmap
#define pread TestRead
#define pwrite TestWrite
#include "webp-output.c"
#undef mmap
#undef munmap
#undef pread
#undef pwrite

#define CHECK(value) do { if (!(value)) { fprintf(stderr, "failed: %s at %d\n", #value, __LINE__); return 1; } } while (0)
static int calls, mode, mutable_source, target;
static uint8_t profile[480];
static uint64_t functions[10] = {1,2,3,4,5,6,7,8,9,10};
static int MacColor(uint8_t* rgba, uint64_t length, const uint8_t* p3, uint32_t p3_size,
                    const uint8_t* srgb, uint32_t srgb_size, const uint64_t* table, uint32_t count) {
  if (p3 != profile || srgb != profile || p3_size != 480 || srgb_size != 480 ||
      table != functions || count != 6) return 99;
  ++calls;
  if (mode == 3) return 3;
  for (uint64_t i = 0; i < length; i += 4) {
    ++rgba[i]; ++rgba[i + 1]; ++rgba[i + 2];
  }
  return 0;
}
static int LinuxColor(uint8_t* rgba, uint64_t length, const uint8_t* p3, uint32_t p3_size,
                      const uint64_t* table, uint32_t count) {
  if (p3 != profile || p3_size != 480 || table != functions || count != 10) return 99;
  ++calls;
  for (uint64_t i = 0; i < length; i += 4) {
    --rgba[i]; --rgba[i + 1]; --rgba[i + 2];
  }
  return 0;
}
static int Decode(int fd, uint64_t input, uint8_t* output, uint64_t output_size,
                  int width, int height, uint64_t budget,
                  uint64_t* peak, uint64_t* remaining, uint64_t* denied) {
  if (input != 3 || width != 3 || height != 2 || output_size != 24 || budget != 1048576) return 99;
  ++calls;
  Set(peak, 32); Set(remaining, 0); Set(denied, mode == 3 ? 1 : 0);
  if (mode == 3) return 3;
  for (uint64_t i = 0; i < output_size; ++i) output[i] = (uint8_t)i;
  if (mode == 4) {
    struct stat stamp; struct timespec times[2];
    if (fstat(mutable_source, &stamp) != 0) return 99;
    times[0] = stamp.st_atim; times[1] = stamp.st_mtim; times[1].tv_sec += 1;
    if (pwrite(mutable_source, "z", 1, 0) != 1 || futimens(mutable_source, times) != 0) return 99;
  }
  if (mode == 5 && ftruncate(target, 1) != 0) return 99;
  if (mode == 6) {
    uint64_t mapped = 99, live = 99;
    int nested = IEWebPConvertFileRGBA(target, 24, 1, profile, 480, profile, 480,
        functions, 6, (uint64_t)(uintptr_t)&MacColor, &mapped, &live);
    if (nested != 1 || mapped != 0 || live != 0) return 99;
  }
  if (lseek(fd, 0, SEEK_CUR) != 2 || lseek(target, 0, SEEK_CUR) != 1) return 99;
  return 0;
}
static int Run(int source, uint64_t* mapped, uint64_t* live) {
  uint64_t peak = 0, remaining = 99, denied = 0;
  return IEWebPDecodeToFile(source, 3, target, 3, 2, 1048576,
      (uint64_t)(uintptr_t)&Decode, &peak, &remaining, &denied, mapped, live);
}

int main(void) {
  const char* temporary = getenv("TMPDIR");
  if (!temporary || !temporary[0]) temporary = "/tmp";
  char directory[4096];
  CHECK(snprintf(directory, sizeof(directory), "%s/ie-webp-output-test-XXXXXX", temporary) < (int)sizeof(directory));
  CHECK(mkdtemp(directory) != NULL);
  char source_path[4096], target_path[4096], link_path[4096];
  CHECK(snprintf(source_path, sizeof(source_path), "%s/source", directory) < (int)sizeof(source_path));
  CHECK(snprintf(target_path, sizeof(target_path), "%s/target", directory) < (int)sizeof(target_path));
  CHECK(snprintf(link_path, sizeof(link_path), "%s/link", directory) < (int)sizeof(link_path));
  mutable_source = open(source_path, O_RDWR | O_CREAT | O_EXCL, 0600);
  target = open(target_path, O_RDWR | O_CREAT | O_EXCL, 0600);
  CHECK(mutable_source >= 0 && target >= 0);
  CHECK(write(mutable_source, "abc", 3) == 3);
  int source = open(source_path, O_RDONLY); CHECK(source >= 0);
  CHECK(lseek(source, 2, SEEK_SET) == 2 && lseek(target, 1, SEEK_SET) == 1);
  CHECK(IEWebPOutputABIVersion() == 1);
  uint64_t mapped = 99, live = 99;
  CHECK(Run(source, &mapped, &live) == 0);
  CHECK(calls == 1 && mapped == (uint64_t)sysconf(_SC_PAGESIZE) && live == 0);
  uint8_t bytes[24]; CHECK(pread(target, bytes, sizeof(bytes), 0) == (ssize_t)sizeof(bytes));
  for (unsigned i = 0; i < sizeof(bytes); ++i) CHECK(bytes[i] == i);
  CHECK(lseek(source, 0, SEEK_CUR) == 2 && lseek(target, 0, SEEK_CUR) == 1);
  CHECK(Run(source, &mapped, &live) == 8 && calls == 1); /* Target not empty. */

  CHECK(IEWebPConvertFileRGBA(target, 24, 1, profile, 480, profile, 480,
      functions, 6, (uint64_t)(uintptr_t)&MacColor, &mapped, &live) == 0);
  CHECK(live == 0 && pread(target, bytes, sizeof(bytes), 0) == (ssize_t)sizeof(bytes));
  for (unsigned i = 0; i < sizeof(bytes); ++i) CHECK(bytes[i] == i + (i % 4 != 3));
  CHECK(IEWebPConvertFileRGBA(target, 24, 2, profile, 480, NULL, 0,
      functions, 10, (uint64_t)(uintptr_t)&LinuxColor, &mapped, &live) == 0);
  CHECK(live == 0 && pread(target, bytes, sizeof(bytes), 0) == (ssize_t)sizeof(bytes));
  for (unsigned i = 0; i < sizeof(bytes); ++i) CHECK(bytes[i] == i);
  mode = 3;
  CHECK(IEWebPConvertFileRGBA(target, 24, 1, profile, 480, profile, 480,
      functions, 6, (uint64_t)(uintptr_t)&MacColor, &mapped, &live) == 3 && live == 0);
  mode = 0;
  fail_read = 1;
  CHECK(IEWebPConvertFileRGBA(target, 24, 1, profile, 480, profile, 480,
      functions, 6, (uint64_t)(uintptr_t)&MacColor, &mapped, &live) == 7 && live == 0);
  fail_read = 0; fail_write = 1;
  CHECK(IEWebPConvertFileRGBA(target, 24, 1, profile, 480, profile, 480,
      functions, 6, (uint64_t)(uintptr_t)&MacColor, &mapped, &live) == 7 && live == 0);
  fail_write = 0;
  CHECK(pread(target, bytes, sizeof(bytes), 0) == (ssize_t)sizeof(bytes));
  for (unsigned i = 0; i < sizeof(bytes); ++i) CHECK(bytes[i] == i);
  CHECK(IEWebPConvertFileRGBA(target, 23, 1, profile, 480, profile, 480,
      functions, 6, (uint64_t)(uintptr_t)&MacColor, &mapped, &live) == 2);
  CHECK(IEWebPConvertFileRGBA(target, 24, 3, profile, 480, profile, 480,
      functions, 6, (uint64_t)(uintptr_t)&MacColor, &mapped, &live) == 2);

  CHECK(ftruncate(target, 0) == 0);
  CHECK(IEWebPDecodeToFile(source, 3, target, 8193, 1, 0,
      (uint64_t)(uintptr_t)&Decode, NULL,NULL,NULL,&mapped,&live) == 2);
  CHECK(IEWebPDecodeToFile(source, 3, target, 5001, 5000, 0,
      (uint64_t)(uintptr_t)&Decode, NULL,NULL,NULL,&mapped,&live) == 2);
  CHECK(IEWebPDecodeToFile(source, 4, target, 3, 2, 0,
      (uint64_t)(uintptr_t)&Decode, NULL,NULL,NULL,&mapped,&live) == 8);
  CHECK(fchmod(target, 0644) == 0 && Run(source,&mapped,&live) == 8);
  CHECK(fchmod(target, 0600) == 0);
  CHECK(link(target_path, link_path) == 0 && Run(source,&mapped,&live) == 8);
  CHECK(unlink(link_path) == 0);
  int writable = target; target = open(target_path,O_RDONLY); CHECK(target >= 0);
  CHECK(Run(source,&mapped,&live) == 8); CHECK(close(target) == 0); target = writable;
  mode = 3;
  CHECK(Run(source,&mapped,&live) == 3 && live == 0);
  CHECK(ftruncate(target,0) == 0); mode = 6;
  CHECK(Run(source,&mapped,&live) == 0 && live == 0); /* Recursive busy refusal. */
  CHECK(ftruncate(target,0) == 0); mode = 4;
  CHECK(Run(source,&mapped,&live) == 8 && live == 0); /* Same-size source changed with explicit mtime advancement. */
  CHECK(ftruncate(target,0) == 0); mode = 5;
  CHECK(Run(source,&mapped,&live) == 8 && live == 0); /* Target resized. */
  mode = 0;
  CHECK(ftruncate(target,0) == 0);
  fail_map = 1;
  CHECK(Run(source,&mapped,&live) == 3 && mapped == 0 && live == 0);
  fail_map = 0;
  fail_write = 1;
  CHECK(Run(source,&mapped,&live) == 7 && live == 0);
  fail_write = 0; interrupt_write = 1; short_write = 1;
  CHECK(Run(source,&mapped,&live) == 0 && live == 0);
  short_write = 0;
  for (int i = 0; i < 100; ++i) {
    CHECK(ftruncate(target,0) == 0);
    CHECK(Run(source,&mapped,&live) == 0 && live == 0);
  }
  /* A failed unmap does not falsely report released bytes or open the lease. */
  CHECK(ftruncate(target,0) == 0); fail_unmap = 1;
  CHECK(Run(source,&mapped,&live) == 7 && live == mapped && live > 0);
  CHECK(Run(source,&mapped,&live) == 1);
  fail_unmap = 0;
  CHECK(munmap(last_mapping,last_mapping_bytes) == 0); /* Test-only recovery. */
  atomic_flag_clear(&bridge_lease);
  CHECK(close(source) == 0 && close(mutable_source) == 0 && close(target) == 0);
  CHECK(unlink(source_path) == 0 && unlink(target_path) == 0 && rmdir(directory) == 0);
  puts("file output bridge invariants passed");
  return 0;
}
