import { allocationLedger, type AllocationLease } from '../src/observability/allocations.js';
import { TextRenderer, releasePrepared, textMemory, type PreparedText, type TextStyle } from '../src/text/client.js';
import { bundledFonts, loadBundledFont } from '../src/text/bundled-fonts.js';
import { hashBytes, TextFailure } from '../src/text/contracts.js';
import type { Reservation } from '../src/text/memory.js';
import { paintTextPreview } from '../src/ui/native-text-preview.js';

export const PREVIEW_WIDTH = 960;
export const PREVIEW_HEIGHT = 540;
export const PREVIEW_TEXT_LIMIT = 2048;
export const PREVIEW_LINE_LIMIT = 16;
export type PreviewDraft = Readonly<{
  text: string; font: string; size: string; color: string;
  align: TextStyle['align']; direction: TextStyle['direction'];
}>;
export const DEFAULT_DRAFT: PreviewDraft = Object.freeze({
  text: 'A little room\nto create.', font: 'NotoSans', size: '96', color: '#194ECA', align: 'start', direction: 'auto',
});
export const FONT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  NotoSans: 'Noto Sans', NotoSansArabic: 'Noto Sans Arabic',
  NotoSansSymbols2: 'Noto Sans Symbols 2', NotoSansCJKsc: 'Noto Sans CJK SC',
});
export const PREVIEW_FONTS = Object.freeze(bundledFonts.map(font => Object.freeze({
  id: font.id, label: FONT_LABELS[font.id] ?? font.id,
})));

type RenderOperation = { generation: number; abort: AbortController; renderer?: TextRenderer };
type ExportOperation = { generation: number };
type Result = {
  pixels: Uint8ClampedArray<ArrayBuffer>; pixelLease: Reservation; surfaceLease: AllocationLease;
  generation: number; text: string; overflow: boolean; references: number;
};

function validateDraft(draft: PreviewDraft) {
  if (!draft.text.trim()) throw Error('Enter some text before rendering.');
  if (draft.text.length > PREVIEW_TEXT_LIMIT) throw Error(`Keep this preview to ${PREVIEW_TEXT_LIMIT.toLocaleString('en-US')} characters. Your text has not been shortened.`);
  let lines = 1;
  for (const scalar of draft.text) if (scalar === '\n') lines++;
  if (lines > PREVIEW_LINE_LIMIT) throw Error(`Use at most ${PREVIEW_LINE_LIMIT} lines in this preview. Your text has not been shortened.`);
  if (!PREVIEW_FONTS.some(font => font.id === draft.font)) throw Error('Choose a bundled font.');
  if (!draft.size.trim() || !Number.isFinite(Number(draft.size)) || Number(draft.size) < 12 || Number(draft.size) > 160)
    throw Error('Enter a font size from 12 to 160 pixels.');
  if (!/^#[0-9a-f]{6}$/i.test(draft.color)) throw Error('Enter a text color as six hexadecimal digits, for example #194ECA.');
  if (!['left', 'center', 'right', 'start', 'end'].includes(draft.align) || !['auto', 'ltr', 'rtl'].includes(draft.direction))
    throw Error('Choose an available alignment and direction.');
  return {
    size: Number(draft.size),
    fill: [1, 3, 5].map(offset => Number.parseInt(draft.color.slice(offset, offset + 2), 16)).concat(255) as [number, number, number, number],
  };
}

function describeFailure(error: unknown): string {
  if (!(error instanceof TextFailure)) return error instanceof Error ? error.message : 'Rendering failed. Your text is unchanged.';
  if (error.code === 'TEXT_MISSING_GLYPHS') {
    const details = error.details as { codepoints?: unknown } | null;
    const points = Array.isArray(details?.codepoints) ? details.codepoints.filter((value): value is number =>
      Number.isInteger(value) && value >= 0 && value <= 0x10ffff).slice(0, 8) : [];
    const names = points.map(value => 'U+' + value.toString(16).toUpperCase().padStart(4, '0')).join(', ');
    return `The selected fonts do not contain ${names || 'one or more characters'}. Choose another bundled font or revise the text. No replacement glyphs were accepted. (${error.code})`;
  }
  const messages: Record<string, string> = {
    TEXT_MEMORY_BUDGET: 'This text and font combination exceeds the renderer’s memory allowance. Try shorter text or a smaller font. Your text is unchanged.',
    TEXT_DEADLINE: 'Rendering took too long. Try shorter text, then render again.',
    TEXT_REQUIRES_REVIEWED_LF_CONVERSION: 'This text contains carriage returns. Replace them with ordinary line breaks before rendering.',
    TEXT_SURROGATE: 'This text contains an incomplete Unicode character. Revise it before rendering.',
    TEXT_ASSET_LOAD: 'A required local font or renderer asset could not load. Reload the page and try again.',
    TEXT_ENGINE_HASH: 'The renderer asset failed its integrity check. Reload the page before trying again.',
    FONT_HASH: 'The font failed its integrity check. Reload the page before trying again.',
    TEXT_TERMINATION_FAILED: 'The previous text worker could not be stopped. Reload this tab before rendering again.',
  };
  return `${messages[error.code] ?? 'The renderer could not accept this preview. Your text is unchanged.'} (${error.code})`;
}

/** Ephemeral UI ownership only. Preview tokens never authorize a document or server operation. */
export class PreviewController {
  #draft: PreviewDraft = DEFAULT_DRAFT;
  #generation = 0;
  #active: RenderOperation | null = null;
  #export: ExportOperation | null = null;
  #result: Result | null = null;
  #download: { url: string; lease: Reservation } | null = null;
  #cleanupFailure: TextRenderer | null = null;
  #suspended = false;
  #message = 'Ready when you are. Render text to create the preview.';
  #error = '';
  readonly #instance = crypto.randomUUID();

  constructor(private readonly canvas: HTMLCanvasElement, private readonly changed: () => void) {}

  get draft() { return this.#draft; }
  get state() {
    return Object.freeze({
      busy: !!this.#active || !!this.#export, rendering: !!this.#active, exporting: !!this.#export,
      unavailable: this.#suspended || !!this.#cleanupFailure,
      hasImage: !!this.#result, current: this.#result?.generation === this.#generation,
      overflow: this.#result?.overflow ?? false, renderedText: this.#result?.text ?? '',
      message: this.#message, error: this.#cleanupFailure ? describeFailure(new TextFailure('TEXT_TERMINATION_FAILED')) : this.#error,
    });
  }

  setDraft(next: PreviewDraft) {
    if (Object.keys(DEFAULT_DRAFT).every(key => next[key as keyof PreviewDraft] === this.#draft[key as keyof PreviewDraft])) return;
    this.#invalidate();
    this.#draft = Object.freeze({ ...next });
    this.#error = '';
    this.#message = this.#result ? 'Draft changed. Render text to update the canvas.' : 'Draft changed. Render text to create the preview.';
    this.changed();
  }

  #invalidate() {
    this.#generation++;
    this.#active?.abort.abort();
    this.#active?.renderer?.cancel();
    this.#clearDownload();
  }
  #current(operation: RenderOperation | ExportOperation) {
    return operation.generation === this.#generation && !this.#suspended && !this.#cleanupFailure;
  }
  #assertCurrent(operation: RenderOperation) {
    if (!this.#current(operation) || operation.abort.signal.aborted) throw new TextFailure('TEXT_CANCELLED');
  }
  #releaseResult(result: Result) {
    if (--result.references) return;
    result.pixels = new Uint8ClampedArray(0);
    result.pixelLease.release();
    result.surfaceLease.release();
  }
  #clearResult() {
    // Clearing the native backing precedes releasing its application reservation.
    this.canvas.width = 0;
    this.canvas.height = 0;
    const previous = this.#result;
    this.#result = null;
    if (previous) this.#releaseResult(previous);
  }
  #clearDownload() {
    if (!this.#download) return;
    URL.revokeObjectURL(this.#download.url);
    this.#download.lease.release();
    this.#download = null;
  }

  cancel() {
    this.#invalidate();
    this.#error = '';
    this.#message = 'Cancelled. Your text is unchanged; render it again when ready.';
    this.changed();
  }

  reset() {
    this.#invalidate();
    this.#clearResult();
    this.#draft = DEFAULT_DRAFT;
    this.#error = '';
    this.#message = 'Preview reset. Render text to start again.';
    this.changed();
  }

  async render() {
    if (this.state.busy || this.state.unavailable) return;
    let values: ReturnType<typeof validateDraft>;
    try { values = validateDraft(this.#draft); }
    catch (error) { this.#error = describeFailure(error); this.changed(); return; }
    this.#invalidate();
    const operation: RenderOperation = { generation: this.#generation, abort: new AbortController() };
    const draft = this.#draft;
    this.#active = operation;
    this.#error = '';
    this.#message = 'Loading the selected font and rendering text…';
    this.changed();
    let prepared: PreparedText | undefined;
    let pixelsLease: Reservation | undefined;
    let surfaceLease: AllocationLease | undefined;
    let requestLease: Reservation | undefined;
    try {
      // At most one bounded draft/request is outstanding, including cancellation.
      // Admission belongs inside the operation's cleanup/error boundary.
      requestLease = textMemory.reserve(PREVIEW_TEXT_LIMIT * 8 + 65536);
      const font = await loadBundledFont(draft.font, operation.abort.signal);
      this.#assertCurrent(operation);
      const fonts = [font];
      if (draft.font !== 'NotoSans') {
        fonts.push(await loadBundledFont('NotoSans', operation.abort.signal));
        this.#assertCurrent(operation);
      }
      operation.renderer = new TextRenderer();
      prepared = await operation.renderer.prepare({
        token: { documentId: 'public-preview', documentRevision: '0', layerId: 'preview-text', layerVersion: '0',
          sessionId: this.#instance, generation: operation.generation },
        text: draft.text, fonts, frame: { width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT },
        style: { primaryFont: font.hash, explicitFallbacks: fonts.slice(1).map(item => item.hash), sizePx: values.size,
          lineHeightMultiplier: 1.15, fill: values.fill, align: draft.align, direction: draft.direction },
      });
      this.#assertCurrent(operation);
      const bytes = PREVIEW_WIDTH * PREVIEW_HEIGHT * 4;
      if (prepared.width !== PREVIEW_WIDTH || prepared.height !== PREVIEW_HEIGHT || prepared.rgba.size !== bytes)
        throw new TextFailure('TEXT_RESULT_BUDGET');
      // Own the copied RGBA, digest input and bounded ImageData submission before reading.
      pixelsLease = textMemory.reserve(bytes * 3 + 4096);
      surfaceLease = allocationLedger.reserve({ owner: 'pages-text-preview', kind: 'canvas',
        gpuBytes: bytes, previewCacheBytes: bytes, handles: 1 });
      const pixels = new Uint8ClampedArray(await prepared.rgba.arrayBuffer());
      this.#assertCurrent(operation);
      if (await hashBytes(pixels) !== prepared.rasterHash) throw new TextFailure('TEXT_RESULT_HASH');
      this.#assertCurrent(operation);
      this.#clearResult();
      try { paintTextPreview(this.canvas, { width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT, pixels }); }
      catch (error) { this.canvas.width = 0; this.canvas.height = 0; throw error; }
      this.#result = { pixels, pixelLease: pixelsLease, surfaceLease, generation: operation.generation,
        text: draft.text, overflow: prepared.overflow, references: 1 };
      pixelsLease = undefined;
      surfaceLease = undefined;
      this.#message = prepared.overflow
        ? 'Rendered. Some text extends beyond the frame; reduce its size or shorten it to show everything.'
        : 'Rendered. The canvas matches your current text and settings.';
    } catch (error) {
      if (this.#current(operation)) { this.#error = describeFailure(error); this.#message = 'The new preview was not accepted. Your text is unchanged.'; }
    } finally {
      pixelsLease?.release();
      surfaceLease?.release();
      if (prepared) releasePrepared(prepared);
      requestLease?.release();
      try { operation.renderer?.dispose(); }
      catch (error) {
        // Retain the real renderer/termination handle; a failed stop grants no new capacity.
        this.#cleanupFailure = operation.renderer!;
        this.#error = describeFailure(error);
      }
      if (this.#active === operation) this.#active = null;
      this.changed();
    }
  }

  async download() {
    const result = this.#result;
    if (!result || result.generation !== this.#generation || this.state.busy || this.state.unavailable) return;
    const operation: ExportOperation = { generation: this.#generation };
    const maxBlobBytes = PREVIEW_WIDTH * PREVIEW_HEIGHT * 4 * 2 + 65536;
    let workspace: Reservation | undefined;
    let url: string | undefined;
    result.references++;
    this.#export = operation;
    this.#error = '';
    this.#message = 'Preparing the displayed canvas as a PNG…';
    this.changed();
    try {
      // Conservative ownership for the fixed canvas encode snapshot and bounded Blob.
      // Native codec overhead/RSS is not inferred from this application reservation.
      workspace = textMemory.reserve(PREVIEW_WIDTH * PREVIEW_HEIGHT * 4 + maxBlobBytes + 65536);
      const blob = await new Promise<Blob>((resolve, reject) => {
        this.canvas.toBlob(value => value ? resolve(value) : reject(Error('The browser could not encode this canvas.')), 'image/png');
      });
      if (!this.#current(operation)) return;
      if (blob.type !== 'image/png' || blob.size <= 0 || blob.size > maxBlobBytes) throw Error('The PNG exceeded this preview’s download limit.');
      workspace = textMemory.replace(workspace, blob.size + 4096);
      this.#clearDownload();
      url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'ideogram-text-preview.png';
      anchor.hidden = true;
      document.body.append(anchor);
      try { anchor.click(); } finally { anchor.remove(); }
      // Hold the Blob URL until the next edit/download, reset or page departure.
      // It is not evidence that the browser has finished writing a destination.
      this.#download = { url, lease: workspace };
      url = undefined;
      workspace = undefined;
      this.#message = 'PNG download started: 960 × 540 pixels with a transparent background.';
    } catch (error) {
      if (this.#current(operation)) this.#error = describeFailure(error);
    } finally {
      if (url) URL.revokeObjectURL(url);
      workspace?.release();
      this.#releaseResult(result);
      if (this.#export === operation) this.#export = null;
      this.changed();
    }
  }

  dispose() {
    this.#suspended = true;
    this.#invalidate();
    this.#clearResult();
    // Pending reads/PNG callbacks keep their own leases until they settle.
    // The worker is terminated by cancel immediately and disposed in render's finally.
    this.#message = 'Preview paused. Your text remains in this tab.';
    this.changed();
  }

  resume() {
    this.#suspended = false;
    this.#message = 'Preview resumed. Render your text again.';
    this.changed();
  }
}
