import ranges from './bidi-data.json';
export function paragraphDirection(text: string): 'ltr' | 'rtl' {
  let isolates = 0;
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    if (cp >= 0x2066 && cp <= 0x2068) { isolates++; continue; }
    if (cp === 0x2069) { isolates = Math.max(0, isolates - 1); continue; }
    if (isolates) continue;
    let lo = 0, hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1, range = ranges[mid];
      if (cp < range[0]) hi = mid - 1;
      else if (cp > range[1]) lo = mid + 1;
      else return range[2] ? 'rtl' : 'ltr';
    }
  }
  return 'ltr';
}
