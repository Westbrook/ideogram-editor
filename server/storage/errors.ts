export type StoreErrorCode = 'ROOT_BUSY' | 'ROOT_UNSAFE' | 'UNSUPPORTED_STORAGE' | 'STALE_EPOCH' |
  'STORAGE_FAILURE' | 'MISSING_OBJECT' | 'CORRUPT_OBJECT' | 'COMMAND_ID_REUSE' |
  'MALFORMED_REQUEST' | 'PROTOCOL_VERSION' | 'PAYLOAD_TOO_LARGE' | 'UNSUPPORTED_COMMAND' |
  'CAPACITY' | 'CLOSED' | 'QUEUE_FULL' | 'CORRUPT_STORE';
export class StoreError extends Error {
  constructor(readonly code: StoreErrorCode) {
    super(code === 'ROOT_UNSAFE' ? 'Use owner-only storage without symbolic links or replaced files.' : code);
  }
}
export function safeError(error: unknown): StoreError {
  return error instanceof StoreError ? error : new StoreError('STORAGE_FAILURE');
}
