import { svg } from 'lit';
const paths: Record<string, string> = {
  spark: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z',
  move: 'm5 3 13 10-6 1-3 6L5 3Z',
  text: 'M4 5h16M12 5v15M8 20h8',
  select: 'M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4M11 4h2M4 11v2m16-2v2m-9 7h2',
  sample: 'm14 3 7 7-3 3-2-2-8 8-5 2 2-5 8-8-2-2 3-3Z',
  mask: 'm4 20 5-1L20 8l-4-4L5 15l-1 5ZM13 7l4 4',
  crop: 'M6 3v15h15M3 6h15v15',
  hand: 'M8 12V6a2 2 0 0 1 4 0v5-7a2 2 0 0 1 4 0v7-5a2 2 0 0 1 4 0v9c0 4-3 6-6 6h-2c-2 0-3-1-4-2l-4-5a2 2 0 0 1 3-3l1 1Z',
  zoom: 'M15 15l6 6M10 6v8M6 10h8M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z',
  layers: 'm12 3 10 5-10 5L2 8l10-5Zm-9 10 9 5 9-5M3 18l9 5 9-5',
  image: 'M4 4h16v16H4V4Zm0 13 5-5 4 4 3-3 4 4M15 8h.01',
  undo: 'M9 5 4 10l5 5M4 10h10a6 6 0 0 1 6 6',
  redo: 'm15 5 5 5-5 5m5-5H10a6 6 0 0 0-6 6',
  settings: 'M4 7h16M4 17h16M9 4v6m6 4v6',
};
export const icon = (name: string) => svg`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${paths[name] ?? paths.spark}></path></svg>`;
