/* Applied only to upstream translation units, after libc declarations. */
#ifndef IDEOGRAM_WEBP_ALLOCATOR_REDIRECT_H
#define IDEOGRAM_WEBP_ALLOCATOR_REDIRECT_H
#include <stddef.h>
#include <stdlib.h>
#if defined(WEBP_USE_THREAD) || defined(HAVE_CONFIG_H)
#error The bounded decoder is a single-thread build without generated configuration.
#endif
void* IEWebPBoundedMalloc(size_t size);
void* IEWebPBoundedCalloc(size_t count, size_t size);
void* IEWebPBoundedRealloc(void* ptr, size_t size);
void IEWebPBoundedFree(void* ptr);
#define malloc IEWebPBoundedMalloc
#define calloc IEWebPBoundedCalloc
#define realloc IEWebPBoundedRealloc
#define free IEWebPBoundedFree
#endif
