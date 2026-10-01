import { gzipSync } from 'node:zlib';
import type { Plugin, Rolldown } from 'vite';
import { readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve, sep } from 'node:path';

export function buildEvidence(app = false): Plugin {
  const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(`${directory}/${entry.name}`) : [`${directory}/${entry.name}`]);
  const sourceSeal = () => [...files('src'), 'index.html', 'vite.app.config.ts', 'tsconfig.json', 'tsconfig.app.json',
    'package.json', 'package-lock.json', '.progress-report/project.json', 'tooling/build-evidence.ts',
    ...files('tooling/theme'), 'vendor/text/manifest.json'].sort().map(path => {
      const bytes = readFileSync(path);
      return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
  let sourceInputs: ReturnType<typeof sourceSeal> | undefined;
  const assertSources = () => {
    if (app && (!sourceInputs || JSON.stringify(sourceSeal()) !== JSON.stringify(sourceInputs))) throw new Error('Application inputs changed during the build; rebuild before qualification.');
  };
  const report = (bundle: Rolldown.OutputBundle, directory?: string) => {
      const boundary = realpathSync(process.cwd()) + sep;
      const outputs = Object.values(bundle).filter(item => item.fileName !== 'build-evidence.json').map(item => {
        if (item.type === 'chunk') for (const id of Object.keys(item.modules)) {
          const file = id.split('?')[0]!;
          if (isAbsolute(file) && !realpathSync(file).startsWith(boundary)) throw new Error(`Module resolved outside the consumer: ${id}`);
        }
        const bytes = item.type === 'chunk' ? Buffer.from(item.code) : Buffer.from(item.source);
        if (directory) {
          const file = resolve(directory, item.fileName);
          if (!file.startsWith(directory + sep)) throw new Error(`Emitted output escaped the build directory: ${item.fileName}`);
          if (!readFileSync(file).equals(bytes)) throw new Error(`Final bundle differs from emitted file: ${item.fileName}`);
        }
        return { file: item.fileName, bytes: bytes.length, ...(app ? { sha256: createHash('sha256').update(bytes).digest('hex') } : {}), gzipBytes: gzipSync(bytes).length,
          entry: item.type === 'chunk' && item.isEntry,
          imports: item.type === 'chunk' ? [...item.imports, ...(app ? item.dynamicImports : [])] : [],
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
      if (forbidden.length) throw new Error(`Forbidden startup dependency: ${forbidden.join(', ')}`);
      return JSON.stringify({
        schema: 1, ...(app ? { sourceInputs, capture: { phase: directory ? 'writeBundle' : 'generateBundle', finalized: !!directory }, toolchain: { node: process.versions.node,
          npm: /^npm\/(\S+)/.exec(process.env.npm_config_user_agent ?? '')?.[1] ?? null } } : {}),
        workload: app ? 'P1a.3 browser shell; all initial dynamic shell imports counted' : 'P1a.1 qualification fixture; not the editor W0/W1 workload',
        observations: { D11: { startupJsRawBytes: initial.reduce((n, item) => n + item.bytes, 0),
          startupJsGzipBytes: initial.reduce((n, item) => n + item.gzipBytes, 0),
          cssGzipBytes: outputs.filter(item => item.file.endsWith('.css')).reduce((n, item) => n + item.gzipBytes, 0) } },
        qualification: 'Unqualified: single artifact, no required campaign or evaluated-module timing', outputs,
      }, null, 2) + '\n';
  };
  return {
    name: 'consumer-build-evidence',
    buildStart() { if (app) sourceInputs = sourceSeal(); },
    generateBundle(_options, bundle) {
      assertSources();
      this.emitFile({ type: 'asset', fileName: 'build-evidence.json', source: report(bundle) });
    },
    writeBundle: {
      order: 'post', sequential: true,
      handler(options, bundle) {
        if (!app) return;
        assertSources();
        if (!options.dir) this.error('Application evidence requires an output directory.');
        const directory = resolve(options.dir);
        const receipt = bundle['build-evidence.json'];
        if (!receipt || receipt.type !== 'asset') this.error('Application evidence asset is missing from the owned build.');
        // Vite may rewrite preloads after generateBundle. Bind only the final
        // owned bundle, and reject disk bytes that were changed independently.
        const source = report(bundle, directory);
        assertSources();
        writeFileSync(resolve(directory, receipt.fileName), source);
        receipt.source = source;
        assertSources();
      },
    },
  };
}
