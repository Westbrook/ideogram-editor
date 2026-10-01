/* Producer-only ownership and failure harness. No libvips implementation or
 * private structure is used: the public function table is replaced by mocks. */
#include "color.c"
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void demand(int ok, const char* expression, int line) {
  if (!ok) {
    fprintf(stderr, "failed: %s at %d\n", expression, line);
    exit(1);
  }
}
#define CHECK(expression) demand(!!(expression), #expression, __LINE__)

enum Failure {
  OK, NEW_NULL, TRANSFORM_FAIL, TRANSFORM_FAIL_WITH_OUTPUT,
  TRANSFORM_NULL, WRITE_NULL, WRITE_SHORT, WRITE_LONG
};
typedef struct {
  int alive;
  const uint8_t* borrowed;
  size_t bytes;
  size_t start;
  int profile_set;
} MockImage;
static MockImage input_image, output_image;
static uint64_t table[FUNCTION_COUNT];
static uint8_t profile[480];
static const uint8_t* original;
static size_t original_pixels, next_pixel;
static enum Failure failure;
static unsigned fail_strip, strip, new_calls, transform_calls, write_calls;
static unsigned input_releases, output_releases, buffer_releases, clears;
static unsigned cache_calls, concurrency_calls, version_calls;
static int cache_value, concurrency_value, bad_version_index;
static int request_reentry, reentry_status;
static uint8_t* allocation;
static size_t allocation_bytes;

static int fails(enum Failure value) {
  return failure == value && strip == fail_strip;
}
static void check_borrowed(void) {
  CHECK(input_image.alive && input_image.borrowed);
  for (size_t i = 0; i < input_image.bytes / 3; ++i) {
    const size_t source = (input_image.start + i) * 4;
    for (size_t channel = 0; channel < 3; ++channel)
      CHECK(input_image.borrowed[i * 3 + channel] == original[source + channel]);
  }
}
static uint8_t transformed(uint8_t source, size_t channel) {
  return (uint8_t)(source ^ (uint8_t)(0x53u + channel * 0x31u));
}
static void* mock_new(const void* data, size_t bytes, int width, int height,
                      int bands, int format) {
  ++new_calls; ++strip;
  CHECK(!input_image.alive && !output_image.alive && !allocation);
  CHECK(data && width > 0 && width <= STRIP_PIXELS);
  CHECK(height == 1 && bands == 3 && format == 0);
  CHECK(bytes == (size_t)width * 3);
  CHECK(next_pixel + (size_t)width <= original_pixels);
  CHECK((size_t)width == (original_pixels - next_pixel < STRIP_PIXELS
    ? original_pixels - next_pixel : STRIP_PIXELS));
  if (request_reentry) {
    uint8_t nested[4] = {1, 2, 3, 4};
    request_reentry = 0;
    reentry_status = IELinuxColorConvertRGBA(nested, sizeof(nested), profile,
      sizeof(profile), table, FUNCTION_COUNT);
    CHECK(reentry_status == 1);
    CHECK(nested[0] == 1 && nested[3] == 4);
  }
  if (fails(NEW_NULL)) return NULL;
  input_image = (MockImage){1, data, bytes, next_pixel, 0};
  next_pixel += (size_t)width;
  check_borrowed();
  return &input_image;
}
static void mock_blob(void* image, const char* name, const void* bytes,
                      size_t size) {
  CHECK(image == &input_image && input_image.alive);
  CHECK(strcmp(name, "icc-profile-data") == 0);
  CHECK(bytes == profile && size == sizeof(profile));
  CHECK(!input_image.profile_set);
  input_image.profile_set = 1;
}
static int mock_transform(void* image, void** result, const char* output, ...) {
  ++transform_calls;
  CHECK(image == &input_image && input_image.alive && input_image.profile_set);
  CHECK(result && *result == NULL && strcmp(output, "srgb") == 0);
  va_list args; va_start(args, output);
  CHECK(strcmp(va_arg(args, const char*), "embedded") == 0);
  CHECK(va_arg(args, int) == 1);
  CHECK(strcmp(va_arg(args, const char*), "intent") == 0);
  CHECK(va_arg(args, int) == 0);
  CHECK(strcmp(va_arg(args, const char*), "depth") == 0);
  CHECK(va_arg(args, int) == 8);
  CHECK(va_arg(args, const char*) == NULL);
  va_end(args);
  check_borrowed();
  if (fails(TRANSFORM_FAIL)) return -1;
  if (fails(TRANSFORM_NULL)) return 0;
  CHECK(!output_image.alive);
  output_image = (MockImage){1, NULL, input_image.bytes, input_image.start, 0};
  *result = &output_image;
  return fails(TRANSFORM_FAIL_WITH_OUTPUT) ? -1 : 0;
}
static void* mock_write(void* image, size_t* size) {
  ++write_calls;
  CHECK(image == &output_image && output_image.alive && size && !allocation);
  check_borrowed();
  if (fails(WRITE_NULL)) { *size = input_image.bytes; return NULL; }
  allocation_bytes = input_image.bytes;
  allocation = malloc(allocation_bytes + 32);
  CHECK(allocation);
  memset(allocation, 0xa7, allocation_bytes + 32);
  for (size_t i = 0; i < allocation_bytes; ++i)
    allocation[16 + i] = transformed(input_image.borrowed[i], i % 3);
  *size = allocation_bytes;
  if (fails(WRITE_SHORT)) --*size;
  if (fails(WRITE_LONG)) ++*size;
  return allocation + 16;
}
static void mock_free(void* value) {
  CHECK(allocation && value == allocation + 16);
  CHECK(input_image.alive && output_image.alive);
  check_borrowed();
  for (size_t i = 0; i < 16; ++i) {
    CHECK(allocation[i] == 0xa7);
    CHECK(allocation[16 + allocation_bytes + i] == 0xa7);
  }
  free(allocation); allocation = NULL; allocation_bytes = 0;
  ++buffer_releases;
}
static void mock_unref(void* image) {
  CHECK(!allocation);
  check_borrowed();
  if (image == &output_image) {
    CHECK(output_image.alive);
    output_image.alive = 0; ++output_releases;
  } else {
    CHECK(image == &input_image && input_image.alive && !output_image.alive);
    input_image.alive = 0; ++input_releases;
  }
}
static void mock_clear(void) {
  CHECK(!allocation && !input_image.alive && !output_image.alive);
  ++clears;
}
static int mock_cache(void) { ++cache_calls; return cache_value; }
static int mock_concurrency(void) { ++concurrency_calls; return concurrency_value; }
static int mock_version(int index) {
  static const int values[] = {8, 18, 6};
  ++version_calls; CHECK(index >= 0 && index < 3);
  return values[index] + (index == bad_version_index ? 1 : 0);
}
static void reset(const uint8_t* source, size_t pixels) {
  CHECK(!allocation && !input_image.alive && !output_image.alive);
  original = source; original_pixels = pixels; next_pixel = 0;
  failure = OK; fail_strip = 1; strip = 0;
  new_calls = transform_calls = write_calls = 0;
  input_releases = output_releases = buffer_releases = clears = 0;
  cache_calls = concurrency_calls = version_calls = 0;
  cache_value = 0; concurrency_value = 1; bad_version_index = -1;
  request_reentry = 0; reentry_status = -1;
}
static int convert(uint8_t* pixels, size_t count) {
  return IELinuxColorConvertRGBA(pixels, count * 4, profile, sizeof(profile),
                                table, FUNCTION_COUNT);
}
static void verify_success(const uint8_t* actual, const uint8_t* source,
                            size_t pixels) {
  const unsigned expected_strips = (unsigned)((pixels + STRIP_PIXELS - 1) / STRIP_PIXELS);
  CHECK(new_calls == expected_strips && transform_calls == expected_strips);
  CHECK(write_calls == expected_strips && input_releases == expected_strips);
  CHECK(output_releases == expected_strips && buffer_releases == expected_strips);
  CHECK(!clears && !allocation && !input_image.alive && !output_image.alive);
  CHECK(next_pixel == pixels);
  for (size_t i = 0; i < pixels; ++i) {
    for (size_t channel = 0; channel < 3; ++channel)
      CHECK(actual[i * 4 + channel] == transformed(source[i * 4 + channel], channel));
    CHECK(actual[i * 4 + 3] == source[i * 4 + 3]);
  }
}
int main(void) {
  table[0] = (uint64_t)(uintptr_t)mock_new;
  table[1] = (uint64_t)(uintptr_t)mock_blob;
  table[2] = (uint64_t)(uintptr_t)mock_transform;
  table[3] = (uint64_t)(uintptr_t)mock_write;
  table[4] = (uint64_t)(uintptr_t)mock_unref;
  table[5] = (uint64_t)(uintptr_t)mock_free;
  table[6] = (uint64_t)(uintptr_t)mock_clear;
  table[7] = (uint64_t)(uintptr_t)mock_cache;
  table[8] = (uint64_t)(uintptr_t)mock_concurrency;
  table[9] = (uint64_t)(uintptr_t)mock_version;
  CHECK(IELinuxColorABIVersion() == 1);
  const size_t capacity = STRIP_PIXELS * 2 + 1;
  uint8_t* source = malloc(capacity * 4);
  uint8_t* pixels = malloc(capacity * 4);
  CHECK(source && pixels);
  for (size_t i = 0; i < capacity; ++i) {
    source[i * 4] = (uint8_t)(i * 17u);
    source[i * 4 + 1] = (uint8_t)(i * 29u + 7u);
    source[i * 4 + 2] = (uint8_t)(i * 43u + 31u);
    source[i * 4 + 3] = (uint8_t)(i % 4 == 0 ? 0 : i % 4 == 1 ? 128 : i % 4 == 2 ? 255 : 64);
  }
  const size_t counts[] = {1, STRIP_PIXELS - 1, STRIP_PIXELS,
    STRIP_PIXELS + 1, STRIP_PIXELS * 2, STRIP_PIXELS * 2 + 1};
  for (size_t i = 0; i < sizeof(counts) / sizeof(counts[0]); ++i) {
    const size_t count = counts[i]; reset(source, count);
    memcpy(pixels, source, count * 4); request_reentry = 1;
    CHECK(convert(pixels, count) == 0 && reentry_status == 1);
    verify_success(pixels, source, count);
  }
  for (int mode = NEW_NULL; mode <= WRITE_LONG; ++mode) {
    for (unsigned at = 1; at <= 2; ++at) {
      reset(source, capacity); memcpy(pixels, source, capacity * 4);
      failure = (enum Failure)mode; fail_strip = at;
      CHECK(convert(pixels, capacity) == 3);
      CHECK(clears == 1 && !allocation && !input_image.alive && !output_image.alive);
      CHECK(new_calls == at);
      CHECK(input_releases == at - (mode == NEW_NULL ? 1u : 0u));
      CHECK(output_releases == at - (mode == NEW_NULL || mode == TRANSFORM_FAIL || mode == TRANSFORM_NULL ? 1u : 0u));
      CHECK(buffer_releases == at - (mode <= WRITE_NULL ? 1u : 0u));
      for (size_t i = 0; i < capacity; ++i) CHECK(pixels[i * 4 + 3] == source[i * 4 + 3]);
      reset(source, 1); memcpy(pixels, source, 4);
      CHECK(convert(pixels, 1) == 0); verify_success(pixels, source, 1);
    }
  }
  for (int condition = 0; condition < 5; ++condition) {
    reset(source, 1); memcpy(pixels, source, 4);
    if (condition == 0) cache_value = 1;
    else if (condition == 1) concurrency_value = 2;
    else bad_version_index = condition - 2;
    CHECK(convert(pixels, 1) == 4);
    CHECK(!new_calls && !clears && !allocation);
    CHECK(memcmp(pixels, source, 4) == 0);
    reset(source, 1); CHECK(convert(pixels, 1) == 0);
    verify_success(pixels, source, 1);
  }
  reset(source, 1); memcpy(pixels, source, 4);
  CHECK(IELinuxColorConvertRGBA(NULL, 4, profile, 480, table, FUNCTION_COUNT) == 2);
  CHECK(IELinuxColorConvertRGBA(pixels, 0, profile, 480, table, FUNCTION_COUNT) == 2);
  CHECK(IELinuxColorConvertRGBA(pixels, 3, profile, 480, table, FUNCTION_COUNT) == 2);
  CHECK(IELinuxColorConvertRGBA(pixels, 100000004, profile, 480, table, FUNCTION_COUNT) == 2);
  CHECK(IELinuxColorConvertRGBA(pixels, 4, NULL, 480, table, FUNCTION_COUNT) == 2);
  CHECK(IELinuxColorConvertRGBA(pixels, 4, profile, 479, table, FUNCTION_COUNT) == 2);
  CHECK(IELinuxColorConvertRGBA(pixels, 4, profile, 480, NULL, FUNCTION_COUNT) == 2);
  CHECK(IELinuxColorConvertRGBA(pixels, 4, profile, 480, table, FUNCTION_COUNT - 1) == 2);
  for (size_t i = 0; i < FUNCTION_COUNT; ++i) {
    const uint64_t saved = table[i]; table[i] = 0;
    CHECK(convert(pixels, 1) == 2); table[i] = saved;
  }
  CHECK(!new_calls && !version_calls && !cache_calls && !concurrency_calls && !clears);
  CHECK(memcmp(pixels, source, 4) == 0);
  CHECK(convert(pixels, 1) == 0); verify_success(pixels, source, 1);
  free(pixels); free(source);
  puts("linux color lifetime invariants passed");
  return 0;
}
