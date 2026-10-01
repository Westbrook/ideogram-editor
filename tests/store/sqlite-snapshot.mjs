// Preserve every column and row, including one-column migration tables. Sort
// ties on all remaining columns so snapshots do not depend on physical row order.
export function tableRows(db, name) {
  const table = '"' + name.replaceAll('"', '""') + '"';
  const order = db.prepare('PRAGMA table_info(' + table + ')').all().map((_, index) => index + 1).join(',');
  if (!order) throw Error('Snapshot table has no columns: ' + name);
  return db.prepare('SELECT * FROM ' + table + ' ORDER BY ' + order).all();
}
