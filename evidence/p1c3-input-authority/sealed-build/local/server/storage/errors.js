export class StoreError extends Error {
    code;
    detail;
    constructor(code, detail) {
        super(code === 'ROOT_UNSAFE' ? 'Use owner-only storage without symbolic links or replaced files.' : code);
        this.code = code;
        this.detail = detail;
    }
}
export function safeError(error) {
    if (error && typeof error === 'object' && (['ENOSPC', 'EDQUOT'].includes(String(error.code)) || error.errcode === 13))
        return new StoreError('STORAGE_FULL');
    return error instanceof StoreError ? error : new StoreError('STORAGE_FAILURE');
}
