import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startLocalServer } from '../server/http.js';

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
    root: options.root ?? join(homedir(), '.ideogram-editor'),
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
  log('Session boundary only; document storage and provider dispatch are unavailable.');
  try { if (options.open !== false) await pair(); }
  catch { await server.close(); throw new Error('Browser launch failed. Start again from a local desktop session.'); }
  return { ...server, pair };
}
