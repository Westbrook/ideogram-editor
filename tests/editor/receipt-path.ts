import {basename,join} from 'node:path';
import {fileURLToPath} from 'node:url';
// Development batches share a runner, not handwritten evidence filenames.
// Formal campaign paths stay unchanged unless the batch flag is explicit.
export function specReceipt(file:string,fallback='artifacts/p1b7/current'):string {
  const root=process.env.EDITOR_RECEIPT??fallback;
  return process.env.IE_VALIDATION_BATCH==='1'?join(root,basename(fileURLToPath(file)).replace(/\.spec\.ts$/,'')):root;
}
