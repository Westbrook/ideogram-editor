// Internal writer injection only. Complete the real content proof, then yield
// asynchronously so a real adapter deletion can commit before SaveDraft does.
import { readFile, writeFile, rename, access } from 'node:fs/promises';
import { join } from 'node:path';

export async function setup(store) {
  const original = store.objects.prove.bind(store.objects);
  const arm = join(store.root, 'draft-deletion-race-arm.json');
  const reached = join(store.root, 'draft-deletion-race-reached.json');
  const release = join(store.root, 'draft-deletion-race-release');
  let used = false, closed = false;
  store.objects.prove = async (ref, check) => {
    const proof = await original(ref, check);
    if (used || closed) return proof;
    let target;
    try { target = JSON.parse(await readFile(arm, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return proof; throw error; }
    if (used || target.hash !== ref.hash) return proof;
    used = true;
    await writeFile(reached + '.tmp', JSON.stringify({ hash: ref.hash, byteLength: ref.byteLength, proofComplete: true }), { mode: 0o600 });
    await rename(reached + '.tmp', reached);
    const deadline = Date.now() + 15000;
    try {
      while (!closed) {
        try { await access(release); return proof; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (Date.now() >= deadline) throw new Error('SaveDraft proof release timed out');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      throw new Error('Writer closed during SaveDraft proof gate');
    } catch (error) { store.objects.releaseProof(proof); throw error; }
  };
  return async () => { closed = true; store.objects.prove = original; };
}
