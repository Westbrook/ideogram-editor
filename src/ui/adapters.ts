// One adapter owns proposal generations. No durable work runs in tentative dispatch.
export class ControlAdapter {
  private generations = new WeakMap<EventTarget, number>();
  private lifetime = 0;
  write<T extends EventTarget, K extends keyof T>(host: T, key: K, value: T[K]) {
    this.generations.set(host, (this.generations.get(host) ?? 0) + 1);
    host[key] = value;
  }
  settled<T>(event: Event, read: () => T, accept: (value: T) => void) {
    const host = event.currentTarget;
    if (!host || event.composedPath()[0] !== host) return;
    const generation = (this.generations.get(host) ?? 0) + 1;
    this.generations.set(host, generation);
    const lifetime = this.lifetime;
    queueMicrotask(() => {
      if (event.defaultPrevented || lifetime !== this.lifetime || this.generations.get(host) !== generation || !(host as Node).isConnected) return;
      accept(read());
    });
  }
  action(event: Event, action: () => void) {
    const host = event.currentTarget as Node, lifetime = this.lifetime;
    // Trusted native dispatch can run a microtask checkpoint between listeners.
    // Wait for the dispatch task to finish so a later listener can still veto.
    setTimeout(() => { if (!event.defaultPrevented && host.isConnected && lifetime === this.lifetime) action(); },0);
  }
  invalidate() { this.lifetime++; }
}
