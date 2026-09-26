import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { startLocalServer } from '../server/http.js';

export async function defaultStorageRoot(home = homedir(), platform = process.platform, dataHome = process.env.XDG_DATA_HOME): Promise<string> {
  const legacy = join(home, '.ideogram-editor');
  if (await lstat(legacy).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
    throw new Error('An earlier storage directory exists. Select it deliberately with --root; no files were moved.');
  }
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'ideogram-edit');
  if (platform === 'linux') {
    if (dataHome && !isAbsolute(dataHome)) throw new Error('XDG_DATA_HOME must be absolute.');
    return join(dataHome || join(home, '.local', 'share'), 'ideogram-edit');
  }
  throw new Error('Storage is not qualified for this platform.');
}

export async function openBrowser(url: string): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  await new Promise<void>((resolve, reject) => {
    // Direct argv, no shell, no inherited output that could echo the fragment.
    const child = spawn(command, [url], { stdio: 'ignore', shell: false });
    child.once('error', () => reject(new Error('The local browser could not be opened.')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('The local browser could not be opened.')));
  });
}

export async function launch(options: {
  root?: string;
  staticDirectory?: string;
  open?: boolean;
  openBrowser?: (url: string) => Promise<void>;
  log?: (message: string) => void;
}) {
  const server = await startLocalServer({
    root: options.root ?? await defaultStorageRoot(),
    staticDirectory: options.staticDirectory,
    credentialConfigured: Boolean(process.env.FAL_KEY),
  });
  const log = options.log ?? console.log;
  const opener = options.openBrowser ?? openBrowser;
  const pair = async () => {
    await opener(server.issuePairingURL());
    log('Opened a fresh pairing link in the local browser.');
  };
  log(`Ideogram Editor local server: ${server.origin}`);
  log(`Private storage root: ${server.root}`);
  log('Durable writer started. Browser editing and provider dispatch remain unavailable.');
  try { if (options.open !== false) await pair(); }
  catch { await server.close(); throw new Error('Browser launch failed. Start again from a local desktop session.'); }
  return { ...server, pair };
}
