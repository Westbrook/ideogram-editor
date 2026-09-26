import { fileURLToPath } from 'node:url';
import { isAbsolute, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { launch } from './launcher.js';

try {
  if (process.versions.node !== '26.10.0') throw new Error();
  const args = process.argv.slice(2);
  let root: string | undefined;
  let staticDirectory: string | undefined = fileURLToPath(new URL('../../app', import.meta.url));
  let open = true;
  const absolute = (path: string) => isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--no-open') open = false;
    else if (arg === '--root' && args[index + 1]) root = absolute(args[++index]);
    else if (arg === '--static' && args[index + 1]) staticDirectory = absolute(args[++index]);
    else throw new Error();
  }
  const server = await launch({ root, staticDirectory, open });
  const input = createInterface({ input: process.stdin, terminal: false });
  let opening = false;
  input.on('line', line => {
    if (line === 'pair' && !opening) {
      opening = true;
      void server.pair().catch(() => console.error('Pairing browser could not open; type pair to try a fresh link.')).finally(() => { opening = false; });
    }
  });
  console.log('Type pair and Enter for a fresh browser pairing link. Press Ctrl-C to stop.');
  const stop = () => { input.close(); void server.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch {
  // Native errors can contain paths/argv; emit only a fixed safe diagnostic.
  console.error('Local launch failed. Use Node 26.10.0, an owner-only root with no symlinks, and --static only for a trusted browser build.');
  process.exitCode = 1;
}
