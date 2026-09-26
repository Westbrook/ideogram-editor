#!/usr/bin/env python3
"""Apply auditable source changes to the exact isolated official checkout."""
import difflib
import pathlib
import sys

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'artifacts/p1c1/custom-source/skia-5f262bd2cbb40f78659ec32547163fe83117a38d')
patch = []


def edit(name, transform):
    path = root / name
    original = path.read_text()
    updated = transform(original)
    assert updated != original, name
    patch.extend(difflib.unified_diff(original.splitlines(True), updated.splitlines(True),
                                    fromfile='a/' + name, tofile='b/' + name))
    path.write_text(updated)


edit('modules/canvaskit/BUILD.gn', lambda s: s.replace('"-sINITIAL_MEMORY=128MB",',
     '"-sINITIAL_MEMORY=16MB",\n    "-sMAXIMUM_MEMORY=32MB",'))
edit('modules/canvaskit/compile.sh', lambda s: s.replace('./bin/fetch-gn',
     '# Task recipe supplies the sealed official GN binary.').replace('./bin/fetch-ninja',
     '# Task recipe supplies the sealed official Ninja binary.').replace(
     '${NINJA} -C ${BUILD_DIR} canvaskit.js', '${NINJA} -j4 -C ${BUILD_DIR} canvaskit.js'))

bounded = '''
// App adapter: check native expansion before allocating any exported JS arrays.
// Native storage is already contained in the hard-limited WASM heap.
JSArray GetShapedLinesBounded(para::Paragraph& self, unsigned maxGlyphs,
                             unsigned maxRuns, unsigned maxLines) {
    uint64_t glyphs = 0, runs = 0;
    bool fits = self.lineNumber() <= maxLines;
    self.visit([&](int, const para::Paragraph::VisitorInfo* info) {
        if (info) {
            if (info->count < 0) { fits = false; return; }
            glyphs += info->count;
            ++runs;
            fits = fits && glyphs <= maxGlyphs && runs <= maxRuns;
        }
    });
    return fits ? GetShapedLines(self) : emscripten::val::null();
}

Float32Array GetRectsForRangeBounded(para::Paragraph& self, unsigned start,
    unsigned end, para::RectHeightStyle heightStyle, para::RectWidthStyle widthStyle,
    unsigned maxRects) {
    auto boxes = self.getRectsForRange(start, end, heightStyle, widthStyle);
    if (boxes.size() > maxRects) return emscripten::val::null();
    if (boxes.empty()) return emscripten::val::global("Float32Array").new_(0);
    return TextBoxesToFloat32Array(boxes);
}

'''
edit('modules/canvaskit/paragraph_bindings.cpp', lambda s: s.replace(
     '#include "include/core/SkColor.h"', '#include "include/core/SkColor.h"\n#include "include/core/SkGraphics.h"').replace(
     'EMSCRIPTEN_BINDINGS(Paragraph) {', 'EMSCRIPTEN_BINDINGS(Paragraph) {\n    function("purgeOwnedTextCaches", &SkGraphics::PurgeFontCache);').replace(
     'std::vector<SkUnicode::Position> convertArrayU32', bounded + 'std::vector<SkUnicode::Position> convertArrayU32').replace(
     '.function("getShapedLines", &GetShapedLines)',
     '.function("getShapedLines", &GetShapedLines)\n        .function("getShapedLinesBounded", &GetShapedLinesBounded)\n        .function("getRectsForRangeBounded", &GetRectsForRangeBounded)'))
edit('modules/canvaskit/memory.js', lambda s: s.replace(
     'ptr = CanvasKit._malloc(arr.length * bytesPerElement);',
     'ptr = CanvasKit._malloc(arr.length * bytesPerElement);\n    if (!ptr) { throw new RangeError("TEXT_NATIVE_ALLOCATION"); }'))
patch_path = pathlib.Path('tooling/text/canvaskit-source.patch')
if len(sys.argv) > 1:
    assert patch_path.read_text() == ''.join(patch), 'Source patch differs from sealed recipe'
else:
    patch_path.write_text(''.join(patch))
