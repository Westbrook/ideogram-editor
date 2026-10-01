import { posix } from 'node:path';
import { D11_ROLE_CONTEXT, verifyD11RegistrationContract } from './browser-d11-registration.mjs';

const sorted = values => [...new Set(values)].sort();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (dictionary, key) => object(dictionary) && Object.hasOwn(dictionary, key) ? dictionary[key] : undefined;
const code = path => /\.[cm]?[jt]sx?$/.test(path) && !/\.d\.[cm]?ts$/.test(path);
const scope = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'MethodDefinition', 'PropertyDefinition', 'AccessorProperty', 'TSDeclareFunction']);
const field = node => ['PropertyDefinition', 'AccessorProperty'].includes(node?.type);
const boundaryScope = node => scope.has(node.type) && !(field(node) && node.static === true);

function literal(node) {
  if (node?.type === 'Literal' || node?.type === 'StringLiteral') return typeof node.value === 'string' ? node.value : null;
  if (node?.type === 'TemplateLiteral' && !node.expressions?.length && node.quasis?.length === 1) return node.quasis[0].value?.cooked ?? null;
  return null;
}

function walk(root, visit) {
  const queue = [[root, false, null]]; let count = 0;
  while (queue.length) {
    const [node, deferred, parent] = queue.pop();
    if (!node || typeof node.type !== 'string') continue;
    if (++count > 2_000_000) throw Error('AST node bound exceeded');
    visit(node, deferred, parent);
    const childDeferred = deferred || boundaryScope(node);
    for (const [key, value] of Object.entries(node)) {
      if (['parent', 'comments', 'tokens', 'loc', 'range'].includes(key)) continue;
      if (Array.isArray(value)) { for (const child of value) if (object(child)) queue.push([child, childDeferred, node]); }
      else if (object(value)) queue.push([value, childDeferred, node]);
    }
  }
}

// Lexical nesting does not establish a lazy boundary: an IIFE or a named
// bootstrap can run during module evaluation. Resolve local callable bindings
// without executing code. Passing an import-bearing callback to a caller whose
// invocation contract is not proved leaves that boundary ambiguous.
function invocationBoundaries(ast) {
  const owners = new WeakMap(), functions = new WeakMap(), classes = new WeakMap(), records = [], bindings = [], calls = [], escapes = [];
  const record = parent => { const value = { parent, bindings: new Map(), invoked: new Set(), callbacks: new Set() }; records.push(value); return value; };
  const root = record(null);
  walk(ast, (node, _deferred, parent) => {
    const outer = parent ? owners.get(parent) : root;
    const klass = ['ClassDeclaration', 'ClassExpression'].includes(node.type) ? node : parent ? classes.get(parent) : null;
    classes.set(node, klass);
    if (boundaryScope(node)) { const current = record(outer); Object.assign(current, { klass, instanceField: field(node) }); functions.set(node, current); }
    const owner = functions.get(node) ?? outer; owners.set(node, owner);
    if (node.type === 'FunctionDeclaration' && node.id?.type === 'Identifier') bindings.push([outer, node.id.name, node]);
    if (node.type === 'FunctionExpression' && node.id?.type === 'Identifier') bindings.push([owner, node.id.name, node]);
    if (node.type === 'ClassDeclaration' && node.id?.type === 'Identifier') bindings.push([outer, node.id.name, node]);
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') bindings.push([owner, node.id.name, node.init]);
    if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier') bindings.push([owner, node.left.name, node.right]);
    if (node.type === 'AssignmentExpression' && node.left?.type === 'MemberExpression') escapes.push([owner, node.right]);
    if (node.type === 'ExportDefaultDeclaration') escapes.push([owner, node.declaration]);
    if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration?.type === 'VariableDeclaration') for (const declaration of node.declaration.declarations) escapes.push([owner, declaration.init]);
      else if (node.declaration) escapes.push([owner, node.declaration]);
      for (const specifier of node.specifiers ?? []) escapes.push([owner, specifier.local]);
    }
    if (functions.has(node)) for (const parameter of node.params ?? []) if (parameter.type === 'Identifier') bindings.push([owner, parameter.name, null]);
    if (node.type === 'CallExpression' || node.type === 'NewExpression') calls.push([owner, node, klass]);
  });
  for (const [owner, name, value] of bindings) { const values = owner.bindings.get(name) ?? []; values.push(value); owner.bindings.set(name, values); }
  const unwrap = node => {
    while (node && ['ParenthesizedExpression', 'ChainExpression', 'TSAsExpression', 'TSTypeAssertion', 'TSNonNullExpression'].includes(node.type)) node = node.expression;
    return node;
  };
  function values(node, owner, seen = new Set()) {
    node = unwrap(node); if (!node || seen.has(node)) return [];
    const next = new Set(seen); next.add(node);
    if (node.type === 'Identifier') {
      for (let current = owner; current; current = current.parent) if (current.bindings.has(node.name)) return current.bindings.get(node.name).flatMap(value => values(value, current, next));
      return [];
    }
    if (node.type === 'SequenceExpression') return values(node.expressions.at(-1), owner, next);
    if (node.type === 'ConditionalExpression') return [...values(node.consequent, owner, next), ...values(node.alternate, owner, next)];
    if (node.type === 'LogicalExpression') return [...values(node.left, owner, next), ...values(node.right, owner, next)];
    return [node];
  }
  function classMembers(klass, name, construct, owner, seen = new Set()) {
    if (seen.has(klass)) return [];
    const next = new Set(seen); next.add(klass);
    const local = (klass.body?.body ?? []).flatMap(member => {
      const key = member.computed ? literal(member.key) : member.key?.name ?? literal(member.key);
      if (construct && member.kind === 'constructor') return [functions.get(member.value)].filter(Boolean);
      if (construct && field(member) && member.static !== true) return [functions.get(member)].filter(Boolean);
      return !construct && key === name ? [functions.get(member.value)].filter(Boolean) : [];
    });
    const inherited = construct && klass.superClass ? values(klass.superClass, owner).filter(value => ['ClassDeclaration', 'ClassExpression'].includes(value.type)).flatMap(value => classMembers(value, name, true, owner, next)) : [];
    return [...local, ...inherited];
  }
  function targets(node, owner, construct = false) {
    return values(node, owner).flatMap(value => {
      if (functions.has(value)) return [functions.get(value)];
      if (construct && ['ClassDeclaration', 'ClassExpression'].includes(value.type)) return classMembers(value, null, true, owner);
      if (value.type !== 'MemberExpression') return [];
      const name = value.computed ? literal(value.property) : value.property?.name;
      if (['call', 'apply'].includes(name)) return targets(value.object, owner);
      if (value.object?.type === 'ThisExpression' && owner.klass) return classMembers(owner.klass, name, false, owner);
      return values(value.object, owner).flatMap(object => {
        if (['ClassDeclaration', 'ClassExpression'].includes(object.type)) return classMembers(object, name, false, owner);
        if (object.type !== 'ObjectExpression') return [];
        return object.properties.flatMap(property => {
        const key = property.computed ? literal(property.key) : property.key?.name ?? literal(property.key);
        return key === name ? targets(property.value, owner) : [];
        });
      });
    });
  }
  function escapeTargets(node, owner, seen = new Set()) {
    const result = new Set();
    for (const value of values(node, owner)) {
      if (seen.has(value)) continue; const next = new Set(seen); next.add(value);
      if (functions.has(value) || ['ClassDeclaration', 'ClassExpression'].includes(value.type)) {
        walk(value, child => { if (functions.has(child)) result.add(functions.get(child)); });
      } else if (value.type === 'ObjectExpression') {
        for (const property of value.properties) for (const target of escapeTargets(property.value ?? property.argument, owner, next)) result.add(target);
      } else if (value.type === 'ArrayExpression') {
        for (const element of value.elements) for (const target of escapeTargets(element?.type === 'SpreadElement' ? element.argument : element, owner, next)) result.add(target);
      }
    }
    return result;
  }
  for (const [owner, value] of escapes) for (const target of escapeTargets(value, owner)) owner.callbacks.add(target);
  for (const [owner, call, klass] of calls) {
    const context = owner.klass || !klass ? owner : { ...owner, klass };
    for (const target of targets(call.callee, context, call.type === 'NewExpression')) owner.invoked.add(target);
    for (const argument of call.arguments ?? []) for (const target of escapeTargets(argument, owner)) owner.callbacks.add(target);
    // A factory's returned callable requires data-flow proof we do not have.
    // Its nested functions are conservatively possible invocation targets.
    const callee = unwrap(call.callee);
    if (callee?.type === 'CallExpression') for (const factory of targets(callee.callee, owner)) for (const candidate of records) {
      for (let current = candidate.parent; current; current = current.parent) if (current === factory) { owner.callbacks.add(candidate); break; }
    }
  }
  const reached = roots => {
    const result = new Set(), pending = [...roots];
    while (pending.length) { const current = pending.pop(); if (result.has(current)) continue; result.add(current); pending.push(...current.invoked); }
    return result;
  };
  const eager = reached([root]), uncertain = new Set();
  let pending = [...eager].flatMap(owner => [...owner.callbacks]).concat(records.filter(owner => owner.instanceField));
  while (pending.length) { const owner = pending.pop(); if (uncertain.has(owner) || eager.has(owner)) continue; uncertain.add(owner); pending.push(...owner.invoked, ...owner.callbacks); }
  return node => eager.has(owners.get(node)) ? 'eager' : uncertain.has(owners.get(node)) || owners.get(node)?.instanceField ? 'ambiguous' : 'deferred';
}

function reference(from, specifier) {
  if (typeof specifier !== 'string' || !specifier || /[\\\x00-\x20\x7f?#]/.test(specifier)) return null;
  if (!(specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/'))) return null;
  const result = posix.normalize(specifier.startsWith('/') ? specifier.slice(1) : posix.join(posix.dirname(from), specifier));
  return result && result !== '..' && !result.startsWith('../') ? result : null;
}

const unwrap = node => {
  while (node && ['ParenthesizedExpression', 'ChainExpression', 'TSAsExpression', 'TSTypeAssertion', 'TSNonNullExpression'].includes(node.type)) node = node.expression;
  return node;
};
const memberName = node => node?.type === 'MemberExpression' ? node.computed ? literal(node.property) : node.property?.name : null;
const identifier = (node, name) => unwrap(node)?.type === 'Identifier' && unwrap(node).name === name;
const methodName = node => node?.computed ? literal(node.key) : node?.key?.name ?? literal(node?.key);

/** A positive, source-bound invocation witness only. This does not exempt a
 * class or callback from generic uncertainty. The caller must separately verify
 * the native registration contract before using its additional startup roots. */
export function deriveD11ApplicationStartup({ manifest, files, sourceTextByPath, parser, roleContext } = {}) {
  const missing = [], roots = new Set(), witnesses = [];
  const fail = message => { throw Error(message); };
  const exact = (values, message) => values.length === 1 ? values[0] : fail(message);
  const nodes = (ast, predicate, top = false) => { const result = []; walk(ast, (node, deferred) => { if ((!top || !deferred) && predicate(node)) result.push(node); }); return result; };
  const canonical = value => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(item => JSON.parse(canonical(item))) : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);
  try {
    if (canonical(roleContext) !== canonical(D11_ROLE_CONTEXT)) fail('Unsupported D11 public startup context');
    const parsed = new Map();
    const ast = path => {
      if (parsed.has(path)) return parsed.get(path);
      const text = own(sourceTextByPath, path); if (typeof text !== 'string' || text.length > 64 * 1024 * 1024) fail('Public startup source is absent or oversized: ' + path);
      const value = parser.parseSync(path, text, { lang: /\.[cm]?tsx?$/.test(path) ? 'ts' : 'js', sourceType: 'module' });
      if (value.errors?.length || value.program?.type !== 'Program') fail('Public startup source cannot be parsed: ' + path);
      parsed.set(path, value.program); return value.program;
    };
    const sourcePath = (from, specifier) => {
      const value = reference(from, specifier), candidates = value ? [value, value.replace(/\.js$/, '.ts').replace(/\.mjs$/, '.mts').replace(/\.cjs$/, '.cts')] : [];
      return exact(sorted(candidates.filter(path => code(path) && typeof own(sourceTextByPath, path) === 'string')), 'Public startup import lacks one sealed source');
    };
    const importLocal = (tree, packageName, exported) => exact(nodes(tree, node => node.type === 'ImportDeclaration' && literal(node.source) === packageName).flatMap(node => node.specifiers.filter(specifier => specifier.type === 'ImportSpecifier' && (specifier.imported?.name ?? literal(specifier.imported)) === exported).map(specifier => specifier.local.name)), 'Public startup import binding differs: ' + exported);
    const property = (object, name) => exact((object?.type === 'ObjectExpression' ? object.properties : []).filter(item => (item.computed ? literal(item.key) : item.key?.name ?? literal(item.key)) === name), 'Public startup literal property differs: ' + name).value;
    const method = (klass, name) => exact(klass.body.body.filter(item => item.type === 'MethodDefinition' && methodName(item) === name), 'Public startup method differs: ' + name).value;
    const names = pattern => !pattern ? [] : pattern.type === 'Identifier' ? [pattern.name]
      : pattern.type === 'ObjectPattern' ? pattern.properties.flatMap(item => names(item.type === 'RestElement' ? item.argument : item.value))
      : pattern.type === 'ArrayPattern' ? pattern.elements.flatMap(names)
      : names(pattern.type === 'AssignmentPattern' ? pattern.left : pattern.type === 'RestElement' ? pattern.argument : pattern.type === 'TSParameterProperty' ? pattern.parameter : null);
    const stable = (tree, name, { ownedReceiver = false, constNode } = {}) => {
      let declarations = 0;
      if (constNode && !nodes(tree, node => node.type === 'VariableDeclaration' && node.kind === 'const' && node.declarations.includes(constNode)).length) fail('Public startup binding must be const: ' + name);
      walk(tree, (node, _deferred, parent) => {
        const bound = node.type === 'VariableDeclarator' ? names(node.id) : ['ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(node.type) ? names(node.local)
          : ['FunctionDeclaration', 'FunctionExpression', 'ClassDeclaration', 'ClassExpression'].includes(node.type) ? names(node.id) : node.type === 'CatchClause' ? names(node.param) : [];
        declarations += bound.filter(value => value === name).length;
        if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) declarations += (node.params ?? []).flatMap(names).filter(value => value === name).length;
        let written = node.type === 'AssignmentExpression' ? node.left : node.type === 'UpdateExpression' || node.type === 'UnaryExpression' && node.operator === 'delete' ? node.argument : null;
        while (unwrap(written)?.type === 'MemberExpression') written = unwrap(written).object;
        if (identifier(written, name)) fail('Public startup binding or member is written: ' + name);
        if (ownedReceiver && node.type === 'Identifier' && node.name === name && !(parent?.type === 'VariableDeclarator' && parent.id === node) && !(parent?.type === 'MemberExpression' && parent.object === node)) fail('Public startup owned scope escapes or is shadowed: ' + name);
      });
      if (declarations !== 1) fail('Public startup binding is shadowed or duplicated: ' + name);
    };
    const entryFiles = new Set(Object.values(manifest).filter(entry => entry.isEntry).map(entry => entry.file));
    const entrySources = sorted(files.filter(file => entryFiles.has(file.file)).flatMap(file => [...file.sources ?? [], ...file.modules ?? []]).filter(path => path.startsWith('src/') && code(path)));
    const imports = entrySources.flatMap(path => nodes(ast(path), node => node.type === 'VariableDeclarator' && node.id?.type === 'ObjectPattern' && unwrap(node.init)?.type === 'AwaitExpression' && unwrap(unwrap(node.init).argument)?.type === 'ImportExpression', true).map(node => ({ path, node })));
    const bootstrap = exact(imports, 'Public startup requires one top-level awaited module binding');
    const binding = exact(bootstrap.node.id.properties.filter(item => item.type === 'Property' && item.key?.type === 'Identifier' && item.value?.type === 'Identifier'), 'Public startup exported mount binding is ambiguous');
    const exported = binding.key.name, localMount = binding.value.name;
    stable(ast(bootstrap.path), localMount);
    const mounted = exact(nodes(ast(bootstrap.path), node => node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && unwrap(node.init)?.type === 'CallExpression' && identifier(unwrap(node.init).callee, localMount), true), 'Public startup mount is not invoked from the entry');
    stable(ast(bootstrap.path), mounted.id.name, { constNode: mounted });
    if (!nodes(ast(bootstrap.path), node => node.type === 'AwaitExpression' && identifier(node.argument, mounted.id.name), true).length) fail('Public startup does not await mount completion');
    const shellPath = sourcePath(bootstrap.path, literal(unwrap(unwrap(bootstrap.node.init).argument).source)), shell = ast(shellPath);
    const mount = exact(nodes(shell, node => node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'FunctionDeclaration' && node.declaration.id?.name === exported).map(node => node.declaration), 'Public startup mount export differs');
    const factory = importLocal(shell, '@en-reve/elements/element-scope.js', 'createElementScope');
    const scopeBinding = exact(nodes(shell, node => node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && unwrap(node.init)?.type === 'CallExpression' && identifier(unwrap(node.init).callee, factory), true), 'Public startup element scope binding differs');
    const scopeName = scopeBinding.id.name, options = unwrap(scopeBinding.init).arguments[0];
    stable(shell, factory); stable(shell, scopeName, { ownedReceiver: true, constNode: scopeBinding });
    if (!identifier(property(options, 'document'), 'document') || literal(property(options, 'registry')) !== 'auto') fail('Public startup element scope options differ');
    const create = exact(nodes(mount.body, node => node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && unwrap(node.init)?.type === 'CallExpression' && memberName(unwrap(node.init).callee) === 'createElement' && identifier(unwrap(node.init).callee.object, scopeName), true), 'Public startup does not create one registered element');
    stable(mount, create.id.name, { constNode: create });
    const tag = literal(unwrap(create.init).arguments[0]); if (!tag) fail('Public startup element tag is not a literal');
    const definitions = nodes(shell, node => node.type === 'CallExpression' && memberName(node.callee) === 'register' && identifier(node.callee.object, scopeName), true).flatMap(call => call.arguments[0]?.type === 'ArrayExpression' ? call.arguments[0].elements : []).filter(value => value?.type === 'ObjectExpression' && value.properties.some(item => methodName(item) === 'tagName' && literal(item.value) === tag));
    const definition = exact(definitions, 'Public startup tagged registration differs'), className = property(definition, 'elementClass')?.name;
    const klass = exact(nodes(shell, node => node.type === 'ClassDeclaration' && node.id?.name === className, true), 'Public startup element class is ambiguous');
    stable(shell, className);
    if (!identifier(klass.superClass, importLocal(shell, 'lit', 'LitElement'))) fail('Public startup registered class base differs');
    if (!nodes(mount.body, node => node.type === 'CallExpression' && memberName(node.callee) === 'append' && node.arguments.some(argument => identifier(argument, create.id.name)), true).length || !nodes(mount.body, node => node.type === 'AwaitExpression' && memberName(unwrap(node.argument)) === 'updateComplete' && identifier(unwrap(node.argument).object, create.id.name), true).length) fail('Public startup creation/append/update completion trace differs');
    const html = importLocal(shell, 'lit', 'html'), render = method(klass, 'render'), publicActions = [];
    for (const template of nodes(render.body, node => node.type === 'TaggedTemplateExpression' && identifier(node.tag, html))) {
      let prefix = '';
      for (let index = 0; index < template.quasi.expressions.length; index++) {
        prefix += template.quasi.quasis[index].value.cooked;
        const after = template.quasi.quasis[index + 1].value.cooked;
        if (/<en-button\b[^<>]*\s@click=$/.test(prefix.slice(prefix.lastIndexOf('<en-button'))) && /^>Open<\/en-button>/.test(after)) publicActions.push(template.quasi.expressions[index]);
        prefix += '${expression}';
      }
    }
    const action = exact(publicActions, 'Public startup Open click binding differs');
    if (action.type !== 'ArrowFunctionExpression') fail('Public startup Open click must be an explicit action');
    const actionCall = unwrap(action.body);
    if (actionCall?.type !== 'CallExpression' || unwrap(actionCall.callee.object)?.type !== 'ThisExpression' || literal(actionCall.arguments[0]) !== 'open') fail('Public startup Open action target differs');
    const openMethod = method(klass, memberName(actionCall.callee));
    const dispatch = exact(nodes(openMethod.body, node => node.type === 'CallExpression' && memberName(node.callee) && node.callee.object?.type === 'Identifier' && node.arguments[1]?.type === 'ArrowFunctionExpression', true), 'Public startup Open dispatcher is ambiguous');
    const editorName = dispatch.callee.object.name;
    const editorBinding = exact(nodes(shell, node => node.type === 'VariableDeclarator' && node.id?.name === editorName && unwrap(node.init)?.type === 'NewExpression', true), 'Public startup dispatcher owner differs');
    const editorClassLocal = unwrap(editorBinding.init).callee.name;
    stable(shell, editorName, { constNode: editorBinding }); stable(shell, editorClassLocal);
    const editorImport = exact(nodes(shell, node => node.type === 'ImportDeclaration' && node.specifiers.some(item => item.local?.name === editorClassLocal)), 'Public startup dispatcher source differs');
    const editorClassName = exact(editorImport.specifiers.filter(item => item.local?.name === editorClassLocal), 'Public startup dispatcher class binding differs').imported?.name;
    const editorPath = sourcePath(shellPath, literal(editorImport.source)), editorClass = exact(nodes(ast(editorPath), node => node.type === 'ClassDeclaration' && node.id?.name === editorClassName), 'Public startup dispatcher class is absent');
    const run = method(editorClass, memberName(dispatch.callee)), callback = run.params[1]?.name;
    if (callback) stable(run, callback);
    if (!callback || !nodes(run.body, node => node.type === 'AwaitExpression' && unwrap(node.argument)?.type === 'CallExpression' && identifier(unwrap(node.argument).callee, callback), true).length) fail('Public startup dispatcher does not await its action argument');
    const panelCall = exact(nodes(dispatch.arguments[1].body, node => node.type === 'AwaitExpression' && unwrap(node.argument)?.type === 'CallExpression' && unwrap(unwrap(node.argument).callee.object)?.type === 'ThisExpression', true), 'Public startup awaited panel action differs');
    const panelMethod = method(klass, memberName(unwrap(panelCall.argument).callee));
    const dynamic = exact(nodes(panelMethod.body, node => node.type === 'ImportExpression', true), 'Public startup panel import is ambiguous');
    const targetPath = sourcePath(shellPath, literal(dynamic.source));
    const emitted = sorted(files.filter(file => file.kind === 'js' && [...file.sources ?? [], ...file.modules ?? []].includes(targetPath)).map(file => file.file));
    for (const entry of Object.values(manifest)) if (entry.src === targetPath && !emitted.includes(entry.file)) emitted.push(entry.file);
    roots.add(exact(emitted, 'Public startup panel source lacks one emitted binding'));
    witnesses.push({ entry: bootstrap.path, shell: shellPath, editor: editorPath, tag, exportedMount: exported, openMethod: memberName(actionCall.callee), dispatchMethod: memberName(dispatch.callee), panelMethod: memberName(unwrap(panelCall.argument).callee), target: targetPath });
  } catch (error) { missing.push(error instanceof Error ? error.message : 'Public startup invocation proof is unavailable'); }
  return { startupFiles: sorted(roots), witnesses, complete: missing.length === 0, missing };
}

// CSS URL tokens, excluding comments and unrelated quoted strings. Escaped or
// malformed URLs are left incomplete instead of guessing a decoded pathname.
function cssReferences(text) {
  const values = []; let i = 0, complete = true;
  const quoted = quote => {
    let result = ''; i++;
    while (i < text.length && text[i] !== quote) { if (text[i] === '\\') { complete = false; i++; } result += text[i++] ?? ''; }
    if (text[i++] !== quote) complete = false;
    return result;
  };
  while (i < text.length) {
    if (text.slice(i, i + 2) === '/*') { const end = text.indexOf('*/', i + 2); if (end < 0) { complete = false; break; } i = end + 2; continue; }
    if (text[i] === '"' || text[i] === "'") { quoted(text[i]); continue; }
    const importMatch = /^@import\s+/i.exec(text.slice(i));
    if (importMatch) { i += importMatch[0].length; if (text[i] === '"' || text[i] === "'") { values.push(quoted(text[i])); continue; } }
    const match = /^url\s*\(/i.exec(text.slice(i));
    if (match && (i === 0 || !/[\w-]/.test(text[i - 1]))) {
      i += match[0].length; while (/\s/.test(text[i] ?? '') && i < text.length) i++;
      let value = '';
      if (text[i] === '"' || text[i] === "'") value = quoted(text[i]);
      else { while (i < text.length && text[i] !== ')') { if (text[i] === '\\') complete = false; value += text[i++]; } value = value.trim(); }
      while (/\s/.test(text[i] ?? '') && i < text.length) i++;
      if (text[i++] !== ')') complete = false;
      values.push(value); continue;
    }
    i++;
  }
  return { values, complete };
}

/** Classify only verified source/output bytes supplied by loadD11Build. This is
 * a pure build graph analysis, not proof that a browser fetched/evaluated code.
 * parser is the lock-verified Rolldown/Oxc {name, version, parseSync}; TypeScript
 * 7 has no standalone JS AST parser and is not impersonated here. */
export function deriveD11Roles({ manifest, files, sourceTextByPath, outputTextByFile, parser, roleContext, registrationContract } = {}) {
  const missing = new Set(), startup = new Set(), engine = new Set(), ui = new Set(), features = [];
  const finish = () => ({ startupFiles: sorted(startup), lazyFeatures: features.sort((a, b) => a.id.localeCompare(b.id)), textEngineFiles: sorted(engine), uiCssFontFiles: sorted(ui), complete: missing.size === 0, missing: sorted(missing) });
  if (!object(manifest) || !Array.isArray(files) || files.length > 20_000 || !object(sourceTextByPath) || !object(outputTextByFile)) { missing.add('D11 role inputs are absent or invalid'); return finish(); }
  if (parser?.name !== 'rolldown' || typeof parser.version !== 'string' || !parser.version || typeof parser.parseSync !== 'function') { missing.add('D11 lock-verified Rolldown AST parser is unavailable'); return finish(); }
  const byFile = new Map(), bySource = new Map(), edges = new Map(), eager = new Map(), dynamic = new Set(), workers = new Set(), wasmOwners = new Set(), ambiguousImports = [];
  const add = (map, key, value) => { const values = map.get(key) ?? new Set(); values.add(value); map.set(key, values); };
  for (const file of files) {
    if (!object(file) || typeof file.file !== 'string' || byFile.has(file.file)) { missing.add('D11 role file inventory is invalid or duplicated'); continue; }
    byFile.set(file.file, file);
    for (const source of [...file.sources ?? [], ...file.modules ?? []]) {
      if (typeof source !== 'string' || source.startsWith('\0') || source.startsWith('virtual:')) continue;
      add(bySource, source.split('?')[0], file.file);
    }
  }
  for (const [id, entry] of Object.entries(manifest)) {
    if (!object(entry) || !byFile.has(entry.file)) { missing.add('D11 manifest role entry is absent: ' + id); continue; }
    if (entry.src) add(bySource, entry.src, entry.file);
    if (code(id)) add(bySource, id, entry.file);
    for (const key of entry.imports ?? []) {
      if (!own(manifest, key) || !byFile.has(manifest[key].file)) missing.add('D11 static manifest dependency is absent: ' + key);
      else add(edges, entry.file, manifest[key].file);
    }
    for (const css of entry.css ?? []) if (byFile.get(css)?.kind === 'css') add(edges, entry.file, css); else missing.add('D11 manifest CSS is absent: ' + css);
  }
  const resolveSource = (from, specifier) => {
    const path = reference(from, specifier); if (!path) return [];
    const names = [path];
    if (/\.[cm]?js$/.test(path)) names.push(path.replace(/\.js$/, '.ts').replace(/\.mjs$/, '.mts').replace(/\.cjs$/, '.cts'));
    return sorted(names.flatMap(name => [...bySource.get(name) ?? []]).filter(file => byFile.get(file)?.kind === 'js'));
  };
  let wasm = null;
  try {
    const profile = JSON.parse(own(sourceTextByPath, 'src/text/profile.json') ?? own(sourceTextByPath, 'vendor/text/manifest.json'));
    const hash = profile?.engine?.wasm?.sha256, bytes = profile?.engine?.wasm?.bytes;
    if (!/^[a-f0-9]{64}$/.test(hash ?? '') || !Number.isSafeInteger(bytes) || bytes < 1) throw Error('profile');
    const candidates = files.filter(file => file.kind === 'wasm' && file.sha256 === 'sha256:' + hash && file.rawBytes === bytes);
    if (candidates.length !== 1) throw Error('binding');
    wasm = candidates[0].file;
  } catch { missing.add('D11 exact sealed text WASM identity is absent or ambiguous'); }
  const parse = (path, text, source) => {
    if (typeof text !== 'string' || text.length > 64 * 1024 * 1024) { missing.add('D11 verified AST text is absent: ' + path); return null; }
    try {
      const parsed = parser.parseSync(path === 'inline:bootstrap' ? 'bootstrap.js' : path, text, { lang: /\.[cm]?tsx?$/.test(path) ? 'ts' : 'js', sourceType: 'module' });
      if (parsed.errors?.length || parsed.program?.type !== 'Program') throw Error('parse');
      return parsed.program;
    } catch { missing.add('D11 AST could not be parsed: ' + (source ? 'source ' : 'output ') + path); return null; }
  };
  function examine(path, ast, outputs, source) {
    if (!ast) return;
    try {
      const boundary = invocationBoundaries(ast);
      walk(ast, node => {
      const dynamicImport = node.type === 'ImportExpression';
      const staticImport = ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source && node.importKind !== 'type' && node.exportKind !== 'type';
      if (dynamicImport || staticImport) {
        const specifier = literal(node.source);
        if (specifier === null) { if (dynamicImport) missing.add('D11 computed dynamic import is ambiguous: ' + path); return; }
        const targets = source ? resolveSource(path, specifier) : [reference(path, specifier)].filter(file => byFile.get(file)?.kind === 'js');
        if (targets.length > 1) { missing.add('D11 source import maps to multiple emitted chunks: ' + path + ' -> ' + specifier); return; }
        if (!targets.length) {
          if (dynamicImport) missing.add('D11 dynamic import has no verified emitted target: ' + path + ' -> ' + specifier);
          else if (!source && reference(path, specifier)) missing.add('D11 emitted static import is absent: ' + path + ' -> ' + specifier);
          return;
        }
        for (const target of targets) for (const output of outputs) {
          if (staticImport) add(edges, output, target);
          else {
            dynamic.add(target);
            if (boundary(node) === 'eager') add(eager, output, target);
            else if (boundary(node) === 'ambiguous') ambiguousImports.push({ path, output, target });
          }
        }
      }
      if (!source && wasm && literal(node) !== null && reference(path, literal(node)) === wasm) wasmOwners.add(path);
      if (!source && node.type === 'NewExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'Worker') {
        let target = node.arguments?.[0];
        if (target?.type === 'NewExpression' && target.callee?.type === 'Identifier' && target.callee.name === 'URL') target = target.arguments?.[0];
        const file = reference(path, literal(target));
        if (file && byFile.get(file)?.kind === 'js') {
          workers.add(file);
          for (const output of outputs) {
            if (boundary(node) === 'eager') add(eager, output, file);
            else if (boundary(node) === 'ambiguous') ambiguousImports.push({ path, output, target: file });
          }
        }
        else missing.add('D11 Worker URL has no exact emitted literal binding: ' + path);
      }
      });
    } catch { missing.add('D11 AST traversal could not finish: ' + path); }
  }
  for (const file of files) if (file.kind === 'js') examine(file.file, parse(file.file, own(outputTextByFile, file.file), false), [file.file], false);
  for (const [source, outputs] of bySource) {
    if (!code(source)) continue;
    const text = own(sourceTextByPath, source);
    // Dependency modules outside the sealed application source inventory are
    // classified by their verified emitted AST, never by an unsealed disk read.
    if (text === undefined && !source.startsWith('src/')) continue;
    examine(source, parse(source, text, true), [...outputs].filter(file => byFile.get(file)?.kind === 'js'), true);
  }
  const closure = (roots, includeEager = true) => {
    const found = new Set(), pending = [...roots];
    while (pending.length) { const file = pending.pop(); if (found.has(file)) continue; found.add(file); pending.push(...edges.get(file) ?? []); if (includeEager) pending.push(...eager.get(file) ?? []); }
    return found;
  };
  const entries = Object.entries(manifest).filter(([, entry]) => entry?.isEntry === true && byFile.get(entry.file)?.kind === 'js');
  if (!entries.length) missing.add('D11 application entry graph is absent');
  for (const file of closure(entries.map(([, entry]) => entry.file))) startup.add(file);
  if (byFile.has('inline:bootstrap')) startup.add('inline:bootstrap');
  if (roleContext !== undefined || registrationContract !== undefined) {
    try {
      verifyD11RegistrationContract(registrationContract, { lock: JSON.parse(own(sourceTextByPath, 'package-lock.json')) });
      const proof = deriveD11ApplicationStartup({ manifest, files, sourceTextByPath, parser, roleContext });
      if (!proof.complete) for (const reason of proof.missing) missing.add('D11 public startup proof: ' + reason);
      else for (const file of closure(proof.startupFiles)) startup.add(file);
    } catch { missing.add('D11 public startup registration contract could not be verified'); }
  }
  if (wasm && wasmOwners.size === 1) {
    const owner = [...wasmOwners][0], candidates = [...workers].filter(file => closure([file], false).has(owner));
    if (candidates.length === 1) { for (const file of closure(candidates, false)) engine.add(file); engine.add(wasm); }
    else missing.add('D11 exact text WASM owner is not bound to one emitted Worker graph');
  } else if (wasm) missing.add('D11 exact text WASM URL has absent or ambiguous emitted AST owners');
  for (const [id, entry] of Object.entries(manifest)) if (entry?.isDynamicEntry === true && !startup.has(entry.file)) {
    if (!dynamic.has(entry.file)) { missing.add('D11 dynamic manifest entry lacks an AST import binding: ' + id); continue; }
    const files = sorted([...closure([entry.file])].filter(file => !engine.has(file)));
    if (files.length) features.push({ id, files });
  }
  const cssQueue = [...startup].filter(file => byFile.get(file)?.kind === 'css');
  while (cssQueue.length) {
    const file = cssQueue.pop(); if (ui.has(file)) continue; ui.add(file);
    const text = own(outputTextByFile, file);
    if (typeof text !== 'string') { missing.add('D11 verified startup CSS text is absent: ' + file); continue; }
    const tokens = cssReferences(text);
    if (!tokens.complete) missing.add('D11 startup CSS URL tokens are ambiguous: ' + file);
    for (const specifier of tokens.values) {
      if (specifier.startsWith('data:') || specifier.startsWith('#')) continue;
      // CSS permits sibling URLs without a leading ./, unlike ESM imports.
      const target = reference(file, /^(?:\.?\.?\/|\/)/.test(specifier) ? specifier : './' + specifier), asset = byFile.get(target);
      if (!asset) { missing.add('D11 startup CSS URL has no verified asset: ' + file + ' -> ' + specifier); continue; }
      if (asset.kind === 'css') { startup.add(target); cssQueue.push(target); }
      if (asset.kind === 'font') {
        startup.add(target);
        if (asset.authoringFont === false) ui.add(target);
        else if (asset.authoringFont !== true) missing.add('D11 startup font identity classification is absent: ' + target);
      }
    }
  }
  for (const file of startup) {
    if (byFile.get(file)?.authoringFont === true) missing.add('D11 lazy-delivery invariant violated: authoring font is in startup: ' + file);
    if (engine.has(file)) missing.add('D11 lazy-delivery invariant violated: text engine is in startup: ' + file);
  }
  for (const { path, output, target } of ambiguousImports) if (startup.has(output) && !startup.has(target)) missing.add('D11 dynamic import or Worker has an ambiguous invocation boundary: ' + path + ' -> ' + target);
  return finish();
}
