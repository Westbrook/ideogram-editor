import { gzipSync } from 'node:zlib';
import type { Plugin } from 'vite';
import { realpathSync } from 'node:fs';
import { isAbsolute, sep } from 'node:path';

export function buildEvidence(): Plugin {
  return {
    name: 'consumer-build-evidence',
    generateBundle(_options, bundle) {
      const boundary = realpathSync(process.cwd()) + sep;
      const outputs = Object.values(bundle).map(item => {
        if (item.type === 'chunk') for (const id of Object.keys(item.modules)) {
          const file = id.split('?')[0]!;
          if (isAbsolute(file) && !realpathSync(file).startsWith(boundary)) this.error(`Module resolved outside the consumer: ${id}`);
        }
        const bytes = item.type === 'chunk' ? Buffer.from(item.code) : Buffer.from(item.source);
        return { file: item.fileName, bytes: bytes.length, gzipBytes: gzipSync(bytes).length,
          entry: item.type === 'chunk' && item.isEntry,
          imports: item.type === 'chunk' ? item.imports : [],
          modules: item.type === 'chunk' ? Object.keys(item.modules).map(path => path.replace(/^.*\/node_modules\//, 'node_modules/').replace(process.cwd() + '/', '')) : [] };
      });
      const startup = new Set<string>();
      function collect(file: string) {
        if (startup.has(file)) return;
        startup.add(file);
        outputs.find(output => output.file === file)?.imports.forEach(collect);
      }
      outputs.filter(output => output.entry).forEach(output => collect(output.file));
      const initial = outputs.filter(output => startup.has(output.file));
      const forbidden = initial.flatMap(output => output.modules).filter(path => /@en-reve\/elements\/dist\/index\.js$|node_modules\/prosemirror-/.test(path));
      if (forbidden.length) this.error(`Forbidden startup dependency: ${forbidden.join(', ')}`);
      this.emitFile({ type: 'asset', fileName: 'build-evidence.json', source: JSON.stringify({
        schema: 1, workload: 'P1a.1 qualification fixture; not the editor W0/W1 workload',
        observations: { D11: { startupJsRawBytes: initial.reduce((n, item) => n + item.bytes, 0),
          startupJsGzipBytes: initial.reduce((n, item) => n + item.gzipBytes, 0),
          cssGzipBytes: outputs.filter(item => item.file.endsWith('.css')).reduce((n, item) => n + item.gzipBytes, 0) } },
        qualification: 'Unqualified: single artifact, no required campaign or evaluated-module timing', outputs,
      }, null, 2) + '\n' });
    },
  };
}
