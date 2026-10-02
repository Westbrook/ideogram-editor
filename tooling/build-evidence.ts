import { gzipSync } from 'node:zlib';
import type { Plugin, ResolvedConfig, Rolldown } from 'vite';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readSync, realpathSync, writeFileSync, type Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

// The qualification contract independently requires this exact installed-member
// inventory. Keeping it here binds the selection to the existing source seal.
const invocationDependencyPaths = [
  'node_modules/@en-reve/elements/dist/button.js',
  'node_modules/@en-reve/elements/dist/button/element.js',
  'node_modules/@en-reve/elements/dist/button/index.js',
  'node_modules/@en-reve/elements/dist/button/template.js',
  'node_modules/@en-reve/elements/dist/definitions/button.js',
  'node_modules/@en-reve/elements/dist/definitions/tree.js',
  'node_modules/@en-reve/elements/dist/internal/child-upgrades.js',
  'node_modules/@en-reve/elements/dist/internal/dom-kind.js',
  'node_modules/@en-reve/elements/dist/internal/element-registry.js',
  'node_modules/@en-reve/elements/dist/internal/en-element.js',
  'node_modules/@en-reve/elements/dist/internal/focus-participant.js',
  'node_modules/@en-reve/elements/dist/tree.js',
  'node_modules/@en-reve/elements/dist/tree/data-controller.js',
  'node_modules/@en-reve/elements/dist/tree/element.js',
  'node_modules/@en-reve/elements/dist/tree/index.js',
  'node_modules/@en-reve/elements/dist/tree/interaction-controller.js',
  'node_modules/@en-reve/elements/dist/tree/lazy-controller.js',
  'node_modules/@en-reve/elements/dist/tree/move-controller.js',
  'node_modules/@en-reve/elements/package.json',
  'node_modules/@en-reve/primitives/dist/interactions/editing-controller.js',
  'node_modules/@en-reve/primitives/dist/interactions/events.js',
  'node_modules/@en-reve/primitives/dist/interactions/scroll-into-view.js',
  'node_modules/@en-reve/primitives/dist/interactions/signal-controller.js',
  'node_modules/@en-reve/primitives/dist/interactions/static-styles.js',
  'node_modules/@en-reve/primitives/dist/interactions/tree.js',
  'node_modules/@en-reve/primitives/dist/interactions/virtual-collection.js',
  'node_modules/@en-reve/primitives/dist/state/value.js',
  'node_modules/@en-reve/primitives/package.json',
  'node_modules/@lit/reactive-element/package.json',
  'node_modules/@lit/reactive-element/reactive-element.js',
  'node_modules/lit-element/lit-element.js',
  'node_modules/lit-element/package.json',
  'node_modules/lit-html/directive-helpers.js',
  'node_modules/lit-html/directive.js',
  'node_modules/lit-html/directives/repeat.js',
  'node_modules/lit-html/lit-html.js',
  'node_modules/lit-html/package.json',
  'node_modules/lit/directives/repeat.js',
  'node_modules/lit/index.js',
  'node_modules/lit/package.json',
  'node_modules/signal-polyfill/dist/index.js',
  'node_modules/signal-polyfill/package.json',
  'node_modules/signal-utils/dist/subtle/reaction.ts.js',
  'node_modules/signal-utils/package.json',
] as const;
const compilationPaths = ['.progress-report/project.json', 'tooling/build-evidence.ts', 'vite.app.config.ts'] as const;
type CompilationEvidence = {
  schema: 1; profile: 'reviewed-vite-app-1'; configFile: 'vite.app.config.ts'; configLoader: 'bundle';
  command: 'build'; mode: 'production'; configInputs: { path: string; bytes: number; sha256: string }[];
  env: { BASE_URL: '/'; MODE: 'production'; DEV: false; PROD: true };
  inlineTransformOptions: 'none'; userPlugins: ['consumer-build-evidence'];
};

export function buildEvidence(app = false): Plugin {
  const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(`${directory}/${entry.name}`) : [`${directory}/${entry.name}`]);
  const sourceSeal = () => [...files('src'), 'index.html', 'vite.app.config.ts', 'tsconfig.json', 'tsconfig.app.json',
    'package.json', 'package-lock.json', '.progress-report/project.json', 'tooling/build-evidence.ts',
    ...files('tooling/theme'), 'vendor/text/manifest.json'].sort().map(path => {
      const bytes = readFileSync(path);
      return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
  const canonicalSeal = (paths: readonly string[], label: string) => {
    const root = realpathSync(process.cwd());
    const unchanged = (before: Stats, after: Stats) => after.isFile() && !after.isSymbolicLink() &&
      (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const).every(key => before[key] === after[key]);
    return paths.map(path => {
      const absolute = resolve(root, path), before = lstatSync(absolute);
      if (!absolute.startsWith(root + sep) || realpathSync(absolute) !== absolute || !before.isFile() || before.size > 64 * 1024) throw new Error(`Application ${label} is not a bounded canonical ordinary file: ${path}`);
      const handle = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!unchanged(before, fstatSync(handle))) throw new Error(`Application ${label} changed before reading: ${path}`);
        // A fixed allocation keeps a concurrent file growth within the member
        // bound; the final metadata comparison refuses the changed input.
        const bytes = Buffer.alloc(before.size); let offset = 0;
        while (offset < bytes.length) {
          const count = readSync(handle, bytes, offset, bytes.length - offset, offset);
          if (!count) throw new Error(`Application ${label} shortened during reading: ${path}`);
          offset += count;
        }
        if (!unchanged(before, fstatSync(handle)) || !unchanged(before, lstatSync(absolute)) || realpathSync(absolute) !== absolute) throw new Error(`Application ${label} changed while reading: ${path}`);
        return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      } finally { closeSync(handle); }
    });
  };
  const dependencySeal = () => canonicalSeal(invocationDependencyPaths, 'invocation dependency');
  let compilation: CompilationEvidence | undefined;
  let configuredForBuild = false;
  let resolvedCommand: ResolvedConfig['command'] | undefined;
  const captureCompilation = (config: ResolvedConfig): CompilationEvidence => {
    const root = realpathSync(process.cwd()), expectedConfig = resolve(root, 'vite.app.config.ts');
    if (!configuredForBuild || config.command !== 'build' || config.mode !== 'production' || !config.isProduction || config.isWorker || config.devtools !== false) throw new Error('Application compilation requires the reviewed production build configuration.');
    if (config.root !== root || config.configFile !== expectedConfig || realpathSync(config.configFile) !== expectedConfig) throw new Error('Application compilation used a different or noncanonical config file or root.');
    const env = config.env;
    if (!env || Object.getPrototypeOf(env) !== Object.prototype || JSON.stringify(Object.keys(env).sort()) !== JSON.stringify(['BASE_URL', 'DEV', 'MODE', 'PROD']) ||
      env.BASE_URL !== '/' || env.MODE !== 'production' || env.DEV !== false || env.PROD !== true) throw new Error('Application compilation requires the default production environment definitions.');
    const dependencies = config.configFileDependencies;
    const expectedDependencies = compilationPaths.map(path => resolve(root, path)).sort();
    if (!Array.isArray(dependencies) || dependencies.length !== expectedDependencies.length || JSON.stringify([...dependencies].sort()) !== JSON.stringify(expectedDependencies)) throw new Error('Application compilation config dependency inventory differs.');
    // Vite 8.3.1 retains the caller's inline object, adding empty build, worker
    // and optimizeDeps objects and compatibility accessors before config load.
    // A reviewed file path alone is insufficient: API/CLI overrides must not
    // add another resolver, transform, entry, environment or plugin pipeline.
    const inline = config.inlineConfig;
    if (!inline || typeof inline !== 'object' || Array.isArray(inline) || Object.getPrototypeOf(inline) !== Object.prototype) throw new Error('Application compilation inline options are unsupported.');
    for (const [key, value] of Object.entries(inline)) {
      if (value === undefined) continue;
      if (key === 'configFile' && typeof value === 'string' && resolve(root, value) === expectedConfig) continue;
      if (key === 'root' && typeof value === 'string' && resolve(value) === root) continue;
      if ((key === 'configLoader' && value === 'bundle') || (key === 'mode' && value === 'production') || (key === 'base' && value === '/')) continue;
      if ((key === 'logLevel' && typeof value === 'string' && ['info', 'warn', 'error', 'silent'].includes(value)) || (key === 'clearScreen' && typeof value === 'boolean')) continue;
      if (['build', 'worker', 'optimizeDeps'].includes(key) && value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(item => item === undefined)) continue;
      throw new Error(`Application compilation rejects inline override: ${key}`);
    }
    return { schema: 1, profile: 'reviewed-vite-app-1', configFile: 'vite.app.config.ts', configLoader: 'bundle', command: 'build', mode: 'production', env: { BASE_URL: '/', MODE: 'production', DEV: false, PROD: true },
      configInputs: canonicalSeal(compilationPaths, 'compilation input'), inlineTransformOptions: 'none', userPlugins: ['consumer-build-evidence'] };
  };
  let sourceInputs: ReturnType<typeof sourceSeal> | undefined;
  let dependencyInputs: ReturnType<typeof dependencySeal> | undefined;
  const assertSources = () => {
    if (app && (!sourceInputs || JSON.stringify(sourceSeal()) !== JSON.stringify(sourceInputs))) throw new Error('Application inputs changed during the build; rebuild before qualification.');
    if (app && (!dependencyInputs || JSON.stringify(dependencySeal()) !== JSON.stringify(dependencyInputs))) throw new Error('Application invocation dependencies changed during the build; rebuild before qualification.');
    if (app && (!compilation || JSON.stringify(canonicalSeal(compilationPaths, 'compilation input')) !== JSON.stringify(compilation.configInputs))) throw new Error('Application compilation inputs changed during the build; rebuild before qualification.');
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
          // Preserve every installation segment for the app's provenance. A
          // nested dependency must never impersonate its sealed root member.
          modules: item.type === 'chunk' ? Object.keys(item.modules).map(path => app
            ? isAbsolute(path) ? relative(boundary, path).split(sep).join('/') : path
            : path.replace(/^.*\/node_modules\//, 'node_modules/').replace(process.cwd() + '/', '')) : [] };
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
        schema: 1, ...(app ? { sourceInputs, dependencyInputs, compilation, capture: { phase: directory ? 'writeBundle' : 'generateBundle', finalized: !!directory }, toolchain: { node: process.versions.node,
          npm: /^npm\/(\S+)/.exec(process.env.npm_config_user_agent ?? '')?.[1] ?? null } } : {}),
        workload: app ? 'P1a.3 browser shell; all initial dynamic shell imports counted' : 'P1a.1 qualification fixture; not the editor W0/W1 workload',
        observations: { D11: { startupJsRawBytes: initial.reduce((n, item) => n + item.bytes, 0),
          startupJsGzipBytes: initial.reduce((n, item) => n + item.gzipBytes, 0),
          cssGzipBytes: outputs.filter(item => item.file.endsWith('.css')).reduce((n, item) => n + item.gzipBytes, 0) } },
        qualification: 'Unqualified: single artifact, no required campaign or evaluated-module timing', outputs,
      }, null, 2) + '\n';
  };
  const plugin: Plugin = {
    name: 'consumer-build-evidence',
    config(config, environment) {
      if (!app || environment.command !== 'build') return;
      // Compare the actual object, not a trusted-looking plugin name. The
      // config source seal supplies the reviewed implementation identity.
      if (!Array.isArray(config.plugins) || config.plugins.length !== 1 || config.plugins[0] !== plugin) throw new Error('Application compilation requires its sole reviewed user plugin.');
      configuredForBuild = true;
    },
    configResolved(config) {
      resolvedCommand = config.command;
      if (app && config.command === 'build') compilation = captureCompilation(config);
    },
    buildStart() {
      if (app && resolvedCommand !== 'serve') {
        if (!compilation) throw new Error('Application compilation configuration was not captured.');
        sourceInputs = sourceSeal(); dependencyInputs = dependencySeal();
        assertSources();
      }
    },
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
  return plugin;
}
