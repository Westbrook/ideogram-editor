#ifndef IDEOGRAM_LINUX_COLOR_H
#define IDEOGRAM_LINUX_COLOR_H
#include <stdint.h>
#define IE_COLOR_EXPORT __attribute__((visibility("default")))
IE_COLOR_EXPORT uint32_t IELinuxColorABIVersion(void);
/* One synchronous ownership boundary. 0=success,1=busy,2=invalid,
 * 3=native failure,4=unqualified library/settings. */
IE_COLOR_EXPORT int IELinuxColorConvertRGBA(uint8_t*, uint64_t,
  const uint8_t*, uint32_t, const uint64_t*, uint32_t);
#endif
