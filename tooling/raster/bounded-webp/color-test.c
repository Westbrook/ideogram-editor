/* Producer-only LCMS ABI/lifetime test. The mock functions below are ordinary
 * native functions, never JavaScript callbacks and never shipped by the editor. */
#include "color.c"
#include <stdio.h>
#include <string.h>

#define CHECK(condition) do { if (!(condition)) { fprintf(stderr, "failed: %s at %d\n", #condition, __LINE__); return 1; } } while (0)

static unsigned char profile_p3[480], profile_srgb[480];
static int input_handle, output_handle, transform_handle;
static int fail_open, fail_transform, wrong_version, nested, mock_error;
static unsigned opens, closes, creates, transforms, deletes;
static char calls[64];
static size_t calls_used;
static uint64_t table[6];

static void Record(char call) {
  if (calls_used + 1 >= sizeof(calls)) { mock_error = 1; return; }
  calls[calls_used++] = call; calls[calls_used] = '\0';
}
static int MockVersion(void) { Record('V'); return wrong_version ? 2180 : 2190; }
static void* MockOpen(const void* profile, uint32_t size) {
  ++opens; Record(opens == 1 ? 'I' : 'O');
  if (size != 480 || profile != (opens == 1 ? (void*)profile_p3 : (void*)profile_srgb)) mock_error = 1;
  if ((int)opens == fail_open) return NULL;
  return opens == 1 ? &input_handle : &output_handle;
}
static void* MockCreate(void* input, uint32_t input_type, void* output,
                        uint32_t output_type, uint32_t intent, uint32_t flags) {
  ++creates; Record('T');
  if (input != &input_handle || output != &output_handle ||
      input_type != TYPE_RGB8 || output_type != TYPE_RGB8 || intent != 0 || flags != FLAGS_NOCACHE) mock_error = 1;
  return fail_transform ? NULL : &transform_handle;
}
static void MockDo(void* transform, const void* input, void* output, uint32_t count) {
  ++transforms; Record('D');
  if (transform != &transform_handle || count == 0 || count > STRIP_PIXELS || input == output) mock_error = 1;
  if (nested) {
    unsigned char pixel[4] = {11, 22, 33, 44};
    if (IEWebPConvertP3RGBA(pixel, sizeof(pixel), profile_p3, 480,
                          profile_srgb, 480, table, 6) != 1 ||
        memcmp(pixel, (unsigned char[]){11, 22, 33, 44}, 4) != 0) mock_error = 1;
  }
  const unsigned char* from = input;
  unsigned char* into = output;
  for (uint32_t i = 0; i < count * 3; ++i) into[i] = (unsigned char)(from[i] + 1 + i % 3);
}
static void MockDelete(void* transform) {
  ++deletes; Record('X');
  if (transform != &transform_handle || closes != 0) mock_error = 1;
}
static int MockClose(void* profile) {
  ++closes;
  if (profile == &input_handle) Record('i');
  else if (profile == &output_handle) Record('o');
  else mock_error = 1;
  if (!fail_transform && creates && deletes != 1) mock_error = 1;
  return 1;
}
static void Reset(void) {
  fail_open = fail_transform = wrong_version = nested = mock_error = 0;
  opens = closes = creates = transforms = deletes = 0;
  calls_used = 0; calls[0] = '\0';
  table[0] = (uint64_t)(uintptr_t)MockVersion;
  table[1] = (uint64_t)(uintptr_t)MockOpen;
  table[2] = (uint64_t)(uintptr_t)MockCreate;
  table[3] = (uint64_t)(uintptr_t)MockDo;
  table[4] = (uint64_t)(uintptr_t)MockDelete;
  table[5] = (uint64_t)(uintptr_t)MockClose;
}
static int Convert(unsigned char* pixels, uint64_t size) {
  return IEWebPConvertP3RGBA(pixels, size, profile_p3, 480, profile_srgb, 480, table, 6);
}

int main(void) {
  unsigned char rgba[] = {0, 10, 20, 0, 250, 251, 252, 128, 255, 254, 253, 255};
  const unsigned char expected[] = {1, 12, 23, 0, 251, 253, 255, 128, 0, 0, 0, 255};
  Reset(); nested = 1;
  CHECK(Convert(rgba, sizeof(rgba)) == 0);
  CHECK(memcmp(rgba, expected, sizeof(rgba)) == 0);
  CHECK(strcmp(calls, "VIOTDXio") == 0 && !mock_error && !atomic_load(&active));

  /* Native profile/transform failure leaves pixels unchanged and closes only
   * handles actually created. A subsequent conversion proves guard release. */
  for (int failure = 1; failure <= 3; ++failure) {
    unsigned char pixel[] = {10, 20, 30, 40};
    Reset(); if (failure <= 2) fail_open = failure; else fail_transform = 1;
    CHECK(Convert(pixel, sizeof(pixel)) == 3);
    CHECK(memcmp(pixel, (unsigned char[]){10, 20, 30, 40}, 4) == 0);
    CHECK(strcmp(calls, failure == 1 ? "VIOo" : failure == 2 ? "VIOi" : "VIOTio") == 0);
    CHECK(!mock_error && !atomic_load(&active));
    Reset(); CHECK(Convert(pixel, sizeof(pixel)) == 0 && !mock_error && !atomic_load(&active));
  }

  Reset(); wrong_version = 1;
  CHECK(Convert(rgba, sizeof(rgba)) == 4);
  CHECK(strcmp(calls, "V") == 0 && opens == 0 && !atomic_load(&active));

  Reset();
  CHECK(Convert(NULL, 4) == 2);
  CHECK(Convert(rgba, 0) == 2);
  CHECK(Convert(rgba, 3) == 2);
  CHECK(Convert(rgba, 100000004) == 2);
  CHECK(IEWebPConvertP3RGBA(rgba, sizeof(rgba), profile_p3, 479, profile_srgb, 480, table, 6) == 2);
  CHECK(IEWebPConvertP3RGBA(rgba, sizeof(rgba), profile_p3, 480, profile_srgb, 479, table, 6) == 2);
  CHECK(IEWebPConvertP3RGBA(rgba, sizeof(rgba), profile_p3, 480, profile_srgb, 480, table, 5) == 2);
  CHECK(IEWebPConvertP3RGBA(rgba, sizeof(rgba), profile_p3, 480, profile_srgb, 480, NULL, 6) == 2);
  table[4] = 0; CHECK(Convert(rgba, sizeof(rgba)) == 2);
  CHECK(calls_used == 0 && !atomic_load(&active));

  /* Cross the strip boundary to prove the final short strip is converted once
   * and exactly once, including hidden RGB and every original alpha byte. */
  static unsigned char pixels[(STRIP_PIXELS + 1) * 4];
  for (size_t i = 0; i < sizeof(pixels); ++i) pixels[i] = (unsigned char)(i * 17);
  Reset(); CHECK(Convert(pixels, sizeof(pixels)) == 0);
  CHECK(transforms == 2 && strcmp(calls, "VIOTDDXio") == 0 && !mock_error);
  for (size_t i = 0; i < sizeof(pixels); ++i) {
    unsigned char before = (unsigned char)(i * 17);
    CHECK(pixels[i] == (i % 4 == 3 ? before : (unsigned char)(before + 1 + i % 4)));
  }
  puts("color lifetime invariants passed");
  return 0;
}
