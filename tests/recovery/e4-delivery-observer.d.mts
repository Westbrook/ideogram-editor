export type DeliveryObserverOptions = {
  limits?: Partial<Record<'bodyBytes' | 'totalBytes' | 'pending' | 'rows' | 'errors', number>>;
} & (
  | { profile?: undefined; /** E4 only; original consumer callback diagnostics. */ phaseDiagnostics?: true }
  | { profile: 'v45-post' | 'queue-ui' | 'portable-review'; phaseDiagnostics?: never }
);
/** Serialized fixture installation; does not consume or replace native results. */
export function installE4DeliveryObserver(options?: DeliveryObserverOptions): void;
/** Runtime validation checks all identities before exposing a joined pair. The
 * generic result preserves each caller's independently observed record shape. */
export function matchV45Deliveries<Post, Delivery>(
  posts: readonly Post[], deliveries: readonly Delivery[], complete?: boolean,
): Array<{post: Post; delivery: Delivery}>;
