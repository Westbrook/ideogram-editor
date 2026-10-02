/** Types for the existing runtime cancellation classifiers. Opaque retained
 * proofs stay unknown until the unchanged validators inspect them. These types
 * grant neither response completion nor cancellation/qualification authority. */
export interface CancellationResponse {
 readonly requestId: number;
 readonly url: string;
 readonly method: string;
 readonly status: number;
 readonly contentType?: string;
 readonly contentLength?: string;
 readonly etag?: string;
 readonly entityVersion?: string;
}
export interface CancellationEvent {
 readonly channel: string;
 readonly requestId: number;
 readonly url: string;
 readonly method: string;
 readonly resourceType: string;
 readonly failure: Readonly<{errorText: string}> | null;
 readonly response: CancellationResponse | null;
}
export interface RecoveryObservations {
 readonly proofs?: readonly unknown[];
 readonly sse?: readonly unknown[];
}
export function integrationCancellation(
 event: CancellationEvent, origin: string, engine: string,
 downloads?: readonly unknown[], faults?: readonly unknown[],
 fontProofs?: readonly unknown[], importedHeads?: readonly unknown[],
 recovery?: RecoveryObservations, workflowProofs?: readonly unknown[],
): false | string;
export function originalFontCompletion(proof: unknown, event: CancellationEvent): boolean;
export function originalRecoveryCompletion(event: CancellationEvent, proofs: readonly unknown[]): boolean;
export function originalSSECancellation(event: CancellationEvent, origin: string, engine: string, proofs: readonly unknown[]): boolean;
export function originalAssetBodyEOF(event: CancellationEvent, origin: string, proofs: readonly unknown[]): boolean;
export function originalRejectedAssetCancellation(event: CancellationEvent, origin: string, faults: readonly unknown[], proofs: readonly unknown[]): boolean;
