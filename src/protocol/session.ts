// Browser-safe LP-1 session wire types. No server code or credentials belong here.
export type EmptyProtocolRequest = { protocolVersion: 1 };
export type BootstrapRequest = { protocolVersion: 1; pairingToken: string };
export type SessionView = {
  protocolVersion: 1;
  csrfToken: string;
  clientId: string;
  sessionExpiresAt: string;
  idleExpiresAt: string;
};
export type CapabilitiesView = {
  protocolVersion: 1;
  serverVersion: string;
  projectionSchema: number;
  credentialConfigured: boolean;
  storageState: 'ready' | 'pressure' | 'unavailable';
  connectionState: 'online' | 'offline' | 'unknown';
  limits: readonly { id: string; value: string; unit: string; classification: 'admission' | 'qualification' }[];
  profiles: readonly { id: string; version: string; state: 'qualified' | 'unqualified' | 'unavailable' }[];
};
export type LocalErrorDetail =
  | { kind: 'protocol-version'; supportedVersions: readonly number[] }
  | { kind: 'fields'; issues: readonly { path: string; code: string }[] };
export type LocalError = {
  protocolVersion: 1;
  requestId: string;
  error: {
    code: string;
    retry: 'none' | 'same-command' | 'read-or-transfer';
    message: string;
    commandId?: string;
    currentRevision?: string;
    details?: { kind: 'inline'; value: LocalErrorDetail };
  };
};
// Further LP-1 detail/content-reference variants belong to their route owners.
