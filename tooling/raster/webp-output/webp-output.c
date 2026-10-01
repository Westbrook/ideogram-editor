/* File output transport only. Pixel decoding and conversion remain in
 * separately verified, unchanged native libraries supplied by the trusted caller.
 * Every mapped pixel pointer lives inside one synchronous native call. */
#include "webp-output.h"
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#if !(defined(__APPLE__) && defined(__aarch64__)) && \
    !(defined(__linux__) && (defined(__aarch64__) || defined(__x86_64__)))
#error Only separately sealed Darwin arm64 and glibc Linux arm64/x64 are supported.
#endif
_Static_assert(sizeof(void*) == sizeof(uint64_t), "64-bit native pointer ABI");
_Static_assert(sizeof(size_t) == sizeof(uint64_t), "64-bit mapping ABI");
_Static_assert(sizeof(off_t) == sizeof(int64_t), "64-bit file offset ABI");

typedef int (*Decoder)(int, uint64_t, uint8_t*, uint64_t, int, int, uint64_t,
                       uint64_t*, uint64_t*, uint64_t*);
typedef int (*MacConverter)(uint8_t*, uint64_t, const uint8_t*, uint32_t,
                           const uint8_t*, uint32_t, const uint64_t*, uint32_t);
typedef int (*LinuxConverter)(uint8_t*, uint64_t, const uint8_t*, uint32_t,
                             const uint64_t*, uint32_t);

static atomic_flag bridge_lease = ATOMIC_FLAG_INIT;
static int Enter(void) {
  return !atomic_flag_test_and_set_explicit(&bridge_lease, memory_order_acquire);
}
static void Leave(void) {
  atomic_flag_clear_explicit(&bridge_lease, memory_order_release);
}
static void Set(uint64_t* value, uint64_t number) {
  if (value != NULL) *value = number;
}

static int MappingSize(uint64_t raw_bytes, size_t* mapped_bytes) {
  const long page = sysconf(_SC_PAGESIZE);
  if (page <= 0 || page > 65536 || ((unsigned long)page & ((unsigned long)page - 1)) != 0 ||
      raw_bytes == 0 || raw_bytes > 100000000 || raw_bytes % 4 != 0 ||
      raw_bytes > SIZE_MAX - ((size_t)page - 1)) return 0;
  *mapped_bytes = ((size_t)raw_bytes + (size_t)page - 1) & ~((size_t)page - 1);
  return 1;
}

static int OwnedOutput(int fd, uint64_t expected_bytes, struct stat* info) {
  if (fstat(fd, info) != 0 || !S_ISREG(info->st_mode) || info->st_size < 0 ||
      (uint64_t)info->st_size != expected_bytes || info->st_uid != geteuid() ||
      (info->st_mode & 07777) != 0600 || info->st_nlink != 1) return 0;
  const int flags = fcntl(fd, F_GETFL);
  return flags >= 0 && (flags & O_ACCMODE) == O_RDWR && !(flags & O_APPEND);
}

static int SameObject(const struct stat* first, const struct stat* last) {
  return first->st_dev == last->st_dev && first->st_ino == last->st_ino &&
         first->st_mode == last->st_mode && first->st_uid == last->st_uid &&
         first->st_gid == last->st_gid && first->st_nlink == last->st_nlink;
}

static int SameSource(const struct stat* first, const struct stat* last) {
  if (!SameObject(first, last) || first->st_size != last->st_size) return 0;
#if defined(__APPLE__)
  return first->st_mtimespec.tv_sec == last->st_mtimespec.tv_sec &&
         first->st_mtimespec.tv_nsec == last->st_mtimespec.tv_nsec &&
         first->st_ctimespec.tv_sec == last->st_ctimespec.tv_sec &&
         first->st_ctimespec.tv_nsec == last->st_ctimespec.tv_nsec;
#else
  return first->st_mtim.tv_sec == last->st_mtim.tv_sec &&
         first->st_mtim.tv_nsec == last->st_mtim.tv_nsec &&
         first->st_ctim.tv_sec == last->st_ctim.tv_sec &&
         first->st_ctim.tv_nsec == last->st_ctim.tv_nsec;
#endif
}

/* A failed munmap is reported without debiting its live mapping or reopening
 * the library lease. No later call can add another output mapping in that case. */
static int Unmap(uint8_t* mapped, size_t bytes, uint64_t* remaining) {
  int status;
  do { status = munmap(mapped, bytes); } while (status != 0 && errno == EINTR);
  if (status != 0) return 0;
  Set(remaining, 0);
  return 1;
}

/* Anonymous output avoids MAP_SHARED SIGBUS when an output volume fills. All
 * file I/O has ordinary checked errors, fixed <=64 KiB requests, and no heap
 * buffer besides the one anonymous RGBA mapping. Descriptor offsets do not move. */
static int Transfer(int fd, uint8_t* bytes, uint64_t length, int writing) {
  for (uint64_t offset = 0; offset < length;) {
    const size_t wanted = length - offset < 65536 ? (size_t)(length - offset) : 65536;
    ssize_t count;
    do {
      count = writing ? pwrite(fd, bytes + offset, wanted, (off_t)offset)
                      : pread(fd, bytes + offset, wanted, (off_t)offset);
    } while (count < 0 && errno == EINTR);
    if (count <= 0 || (size_t)count > wanted) return 0;
    offset += (uint64_t)count;
  }
  return 1;
}

uint32_t IEWebPOutputABIVersion(void) { return 1; }

int IEWebPDecodeToFile(int source_fd, uint64_t input_bytes, int target_fd,
                      int width, int height, uint64_t budget,
                      uint64_t decoder_function,
                      uint64_t* peak, uint64_t* remaining, uint64_t* denied,
                      uint64_t* output_peak, uint64_t* output_remaining) {
  Set(peak, 0); Set(remaining, 0); Set(denied, 0);
  Set(output_peak, 0); Set(output_remaining, 0);
  if (source_fd < 0 || target_fd < 0 || source_fd == target_fd ||
      input_bytes == 0 || input_bytes > INT64_MAX || !decoder_function ||
      budget > UINT64_C(128) * 1024 * 1024 ||
      width <= 0 || height <= 0 || width > 8192 || height > 8192 ||
      (uint64_t)width * (uint64_t)height > 25000000) return 2;
  const uint64_t raw_bytes = (uint64_t)width * (uint64_t)height * 4;
  size_t mapped_bytes;
  if (!MappingSize(raw_bytes, &mapped_bytes)) return 2;
  if (!Enter()) return 1;
  int result = 8;
  struct stat source_before, target_before;
  if (fstat(source_fd, &source_before) != 0 || !S_ISREG(source_before.st_mode) ||
      source_before.st_size < 0 || (uint64_t)source_before.st_size != input_bytes ||
      !OwnedOutput(target_fd, 0, &target_before) ||
      (source_before.st_dev == target_before.st_dev &&
       source_before.st_ino == target_before.st_ino)) goto done;
  uint8_t* mapped = (uint8_t*)mmap(NULL, (size_t)raw_bytes,
      PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
  if (mapped == MAP_FAILED) { result = 3; goto done; }
  Set(output_peak, mapped_bytes); Set(output_remaining, mapped_bytes);
  Decoder decode = (Decoder)(uintptr_t)decoder_function;
  result = decode(source_fd, input_bytes, mapped, raw_bytes, width, height,
                  budget, peak, remaining, denied);
  struct stat source_after, target_after;
  if (fstat(source_fd, &source_after) != 0 || !SameSource(&source_before, &source_after) ||
      !OwnedOutput(target_fd, 0, &target_after) ||
      !SameObject(&target_before, &target_after)) result = 8;
  if (result == 0 && (!Transfer(target_fd, mapped, raw_bytes, 1))) result = 7;
  if (result == 0 && (fstat(source_fd, &source_after) != 0 ||
      !SameSource(&source_before, &source_after) ||
      !OwnedOutput(target_fd, raw_bytes, &target_after) ||
      !SameObject(&target_before, &target_after))) result = 8;
  if (!Unmap(mapped, mapped_bytes, output_remaining)) return 7;
done:
  Leave();
  return result;
}

int IEWebPConvertFileRGBA(int fd, uint64_t raw_bytes, uint32_t platform_kind,
                         const uint8_t* p3, uint32_t p3_bytes,
                         const uint8_t* srgb, uint32_t srgb_bytes,
                         const uint64_t* function_table, uint32_t function_count,
                         uint64_t converter_function,
                         uint64_t* output_peak, uint64_t* output_remaining) {
  Set(output_peak, 0); Set(output_remaining, 0);
  size_t mapped_bytes;
  if (fd < 0 || !converter_function || !p3 || p3_bytes != 480 ||
      !function_table || !MappingSize(raw_bytes, &mapped_bytes) ||
      (platform_kind != 1 && platform_kind != 2) ||
      (platform_kind == 1 && (!srgb || srgb_bytes != 480 || function_count != 6)) ||
      (platform_kind == 2 && function_count != 10)) return 2;
  for (uint32_t i = 0; i < function_count; ++i) if (!function_table[i]) return 2;
  if (!Enter()) return 1;
  int result = 8;
  struct stat before;
  if (!OwnedOutput(fd, raw_bytes, &before)) goto done;
  uint8_t* mapped = (uint8_t*)mmap(NULL, (size_t)raw_bytes,
      PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
  if (mapped == MAP_FAILED) { result = 3; goto done; }
  Set(output_peak, mapped_bytes); Set(output_remaining, mapped_bytes);
  result = Transfer(fd, mapped, raw_bytes, 0) ? 0 : 7;
  struct stat after;
  if (result == 0 && (!OwnedOutput(fd, raw_bytes, &after) ||
      !SameSource(&before, &after))) result = 8;
  if (result == 0 && platform_kind == 1) {
    MacConverter convert = (MacConverter)(uintptr_t)converter_function;
    result = convert(mapped, raw_bytes, p3, p3_bytes, srgb, srgb_bytes,
                     function_table, function_count);
  } else if (result == 0) {
    LinuxConverter convert = (LinuxConverter)(uintptr_t)converter_function;
    result = convert(mapped, raw_bytes, p3, p3_bytes, function_table, function_count);
  }
  if (result == 0 && (!OwnedOutput(fd, raw_bytes, &after) ||
      !SameSource(&before, &after))) result = 8;
  if (result == 0 && !Transfer(fd, mapped, raw_bytes, 1)) result = 7;
  if (result == 0 && (!OwnedOutput(fd, raw_bytes, &after) ||
      !SameObject(&before, &after))) result = 8;
  if (!Unmap(mapped, mapped_bytes, output_remaining)) return 7;
done:
  Leave();
  return result;
}
