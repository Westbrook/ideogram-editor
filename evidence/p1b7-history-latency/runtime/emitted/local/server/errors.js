import { randomUUID } from 'node:crypto';
const errors = {
    MALFORMED_REQUEST: [400, 'The request does not match the local protocol.'],
    SESSION_REQUIRED: [401, 'Open the editor from the local launcher to pair again.'],
    PAIRING_INVALID: [401, 'This pairing link is expired or already used. Open a fresh link from the local launcher.'],
    ORIGIN_DENIED: [403, 'This request is not from the editor launch origin.'],
    CSRF_DENIED: [403, 'The session security token is missing or invalid.'],
    OWNER_REQUIRED: [403, 'This resource belongs to another local client.'],
    CONTENT_WITHHELD: [403, 'This content is not available for this purpose.'],
    STAGING_ID_REUSE: [409, 'This staging ID belongs to different metadata.'],
    OFFSET_MISMATCH: [409, 'Resume from the committed upload offset.'],
    REVIEW_EXPIRED: [410, 'Prepare a new ownership transfer review.'],
    COMMAND_ID_REUSE: [409, 'This command ID belongs to different content.'],
    CURSOR_INSIDE_TRANSACTION: [409, 'Resume from a complete transaction boundary.'],
    CURSOR_GAP: [410, 'Recover from the pinned snapshot.'],
    READ_CONTEXT_EXPIRED: [410, 'Start a fresh recovery read.'],
    RANGE_NOT_SATISFIABLE: [416, 'The requested byte range is unavailable.'],
    LOCAL_BUSY: [429, 'The local service is busy.'],
    RECOVERY_UNAVAILABLE: [503, 'Complete recovery is temporarily unavailable.'],
    STORAGE_FULL: [507, 'There is insufficient local storage.'],
    NOT_FOUND: [404, 'This local route is not available.'],
    METHOD_NOT_ALLOWED: [405, 'This method is not allowed for this route.'],
    PAYLOAD_TOO_LARGE: [413, 'The control request exceeds 64 KiB.'],
    MEDIA_TYPE: [415, 'Send an uncompressed UTF-8 application/json request.'],
    PROTOCOL_VERSION: [426, 'This server supports local protocol version 1.'],
    SERVER_UNAVAILABLE: [503, 'This local service is not available.'],
};
export class ProtocolError extends Error {
    detail;
    retry;
    commandId;
    code;
    status;
    constructor(code, detail, retry = 'none', commandId) {
        super(errors[code][1]);
        this.detail = detail;
        this.retry = retry;
        this.commandId = commandId;
        this.code = code;
        this.status = errors[code][0];
    }
    toWire() {
        const detail = this.detail ?? (this.code === 'PROTOCOL_VERSION'
            ? { kind: 'protocol-version', supportedVersions: [1] } : undefined);
        return { protocolVersion: 1, requestId: randomUUID(), error: {
                code: this.code, retry: this.retry, message: this.message, ...(this.commandId ? { commandId: this.commandId } : {}),
                ...(detail ? { details: { kind: 'inline', value: detail } } : {}),
            } };
    }
}
