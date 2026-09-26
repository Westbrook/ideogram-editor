// Disposable browser delivery cache. The writer's receipts remain authoritative.
// It contains original command bodies and local drafts, never transport secrets.
export class BrowserJournal {
  private constructor(private db: IDBDatabase) {}
  static async open(owner: string) {
    const request = indexedDB.open('ie-delivery-' + owner, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('entries');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    return new BrowserJournal(db);
  }
  async put(key: string, value: unknown) {
    const tx = this.db.transaction('entries', 'readwrite'); tx.objectStore('entries').put(value, key);
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error); });
  }
  async get<T>(key: string): Promise<T | undefined> {
    const request = this.db.transaction('entries').objectStore('entries').get(key);
    return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  }
  async entries<T>(prefix: string): Promise<T[]> {
    const request = this.db.transaction('entries').objectStore('entries').getAll(IDBKeyRange.bound(prefix, prefix + '\uffff'));
    return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  }
  close() { this.db.close(); }
}
