export type StoreErrorCode = 'ROOT_BUSY' | 'ROOT_UNSAFE' | 'UNSUPPORTED_STORAGE' | 'STALE_EPOCH' |
  'STORAGE_FAILURE' | 'STORAGE_FULL' | 'MISSING_OBJECT' | 'CORRUPT_OBJECT' | 'COMMAND_ID_REUSE' |
  'MALFORMED_REQUEST' | 'PROTOCOL_VERSION' | 'PAYLOAD_TOO_LARGE' | 'UNSUPPORTED_COMMAND' |
  'CAPACITY' | 'CLOSED' | 'QUEUE_FULL' | 'CORRUPT_STORE';
export class StoreError extends Error {
  constructor(readonly code: StoreErrorCode) {
    super(code === 'ROOT_UNSAFE' ? 'Use owner-only storage without symbolic links or replaced files.' : code);
  }
}
export function safeError(error: unknown): StoreError {
  if (error && typeof error === 'object' && (['ENOSPC','EDQUOT'].includes(String((error as NodeJS.ErrnoException).code)) || (error as {errcode?:number}).errcode === 13)) return new StoreError('STORAGE_FULL');
  return error instanceof StoreError ? error : new StoreError('STORAGE_FAILURE');
}
