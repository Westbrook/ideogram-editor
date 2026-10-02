import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { D11_ROLE_CONTEXT } from './browser-d11-registration.mjs';
import { verifyD11InvocationContract } from './browser-d11-invocation-contract.mjs';
import { assertD11EventCorpus } from './browser-d11-private-events.mjs';

const PATHS = Object.freeze({ shell: 'src/ui/shell.ts', native: 'src/ui/native-text.ts', durable: 'src/text/durable.ts',
  client: 'src/text/client.ts', worker: 'src/text/worker.ts', engine: 'src/text/engine.ts' });
const sorted = values => [...new Set(values)].sort();
const fail = message => { throw Error('D11 Worker activation: ' + message); };
const exact = (values, message) => values.length === 1 ? values[0] : fail(message);
const hash = text => 'sha256:' + createHash('sha256').update(text).digest('hex');
const wrappers = new Set(['ChainExpression', 'ParenthesizedExpression', 'TSAsExpression', 'TSTypeAssertion', 'TSNonNullExpression', 'TSSatisfiesExpression']);
const unwrap = node => { while (wrappers.has(node?.type)) node = node.expression; return node; };
const literal = node => ['Literal', 'StringLiteral'].includes(unwrap(node)?.type) ? unwrap(node).value : null;
const id = (node, name) => unwrap(node)?.type === 'Identifier' && unwrap(node).name === name;
const key = node => node?.computed ? literal(node.key ?? node.property) : (node?.key ?? node?.property)?.type === 'PrivateIdentifier'
  ? '#' + (node.key ?? node.property).name : (node?.key ?? node?.property)?.name ?? literal(node?.key ?? node?.property);
const self = (node, name) => unwrap(node)?.type === 'MemberExpression' && unwrap(unwrap(node).object)?.type === 'ThisExpression' && key(unwrap(node)) === name;
const moduleURL = node => unwrap(node)?.type === 'MemberExpression' && !unwrap(node).computed && key(unwrap(node)) === 'url' && unwrap(unwrap(node).object)?.type === 'MetaProperty' && id(unwrap(unwrap(node).object).meta, 'import') && id(unwrap(unwrap(node).object).property, 'meta');
const inside = (node, root) => node.start >= root.start && node.end <= root.end;
const typeOnly = node => /^TS/.test(node?.type ?? '') && !wrappers.has(node.type) && node.type !== 'TSParameterProperty';

function tree(root) {
  const nodes = [], parents = new Map(), pending = [[root, null]];
  while (pending.length) {
    const [node, parent] = pending.pop();
    if (!node || typeof node.type !== 'string' || typeOnly(node)) continue;
    if (nodes.length >= 2_000_000) fail('AST node bound exceeded');
    nodes.push(node); parents.set(node, parent);
    for (const [name, value] of Object.entries(node)) {
      if (['parent', 'comments', 'tokens', 'loc', 'range', 'typeAnnotation', 'typeParameters', 'typeArguments', 'returnType', 'implements', 'superTypeArguments'].includes(name)) continue;
      if (Array.isArray(value)) { for (const child of value) if (child && typeof child === 'object') pending.push([child, node]); }
      else if (value && typeof value === 'object') pending.push([value, node]);
    }
  }
  const parent = node => { let value = parents.get(node); while (wrappers.has(value?.type)) value = parents.get(value); return value; };
  return { root, nodes, parents, parent };
}

function parse(path, text, parser) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 16 * 1048576) fail('bounded retained source is absent: ' + path);
  const parsed = parser.parseSync(path, text, { lang: /\.[cm]?tsx?$/.test(path) ? 'ts' : 'js', sourceType: 'module' });
  if (parsed.errors?.length || parsed.program?.type !== 'Program') fail('retained source cannot be parsed: ' + path);
  return { ...tree(parsed.program), path, text };
}

function klass(parsed, name, inherited = false) {
  const node = exact(parsed.nodes.filter(node => node.type === 'ClassDeclaration' && id(node.id, name)), 'class binding is absent or ambiguous: ' + name);
  if (node.superClass && !inherited) fail('unreviewed class inheritance: ' + name);
  const members = new Map(), allMembers = [...node.body.body];
  for (const member of node.body.body) {
    const prior = members.get(key(member));
    if (!['MethodDefinition', 'PropertyDefinition', 'AccessorProperty'].includes(member.type) || member.computed || prior && !(['get', 'set'].includes(prior.kind) && ['get', 'set'].includes(member.kind) && prior.kind !== member.kind)) fail('class member is computed, duplicated, or unsupported: ' + name);
    members.set(key(member), member);
  }
  const owner = child => allMembers.find(member => inside(child, member));
  return { node, members, owner, method: name => {
    const member = members.get(name); if (member?.type !== 'MethodDefinition') fail('method binding is absent: ' + name); return member;
  } };
}

function resolved(from, specifier, texts) {
  if (typeof specifier !== 'string' || !specifier.startsWith('.') || /[\\?#\x00-\x20]/.test(specifier)) return null;
  const value = posix.normalize(posix.join(posix.dirname(from), specifier));
  return [value, value.replace(/\.js$/, '.ts'), value + '.ts', value + '.js'].find(path => Object.hasOwn(texts, path)) ?? value;
}

function bindingCensus(parsed, texts, target, exported, expectedImporters) {
  const importers = [];
  for (const [path, source] of parsed) for (const node of source.nodes) {
    const specifier = node.type === 'ImportExpression' ? literal(node.source) : ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) ? literal(node.source) : null;
    if (resolved(path, specifier, texts) !== target) continue;
    if (node.type !== 'ImportDeclaration' || node.importKind === 'type') {
      if (node.importKind === 'type') continue;
      fail('dynamic or re-exported activation owner: ' + target);
    }
    if (node.specifiers.some(specifier => specifier.type !== 'ImportSpecifier')) fail('namespace/default activation owner: ' + target);
    for (const specifier of node.specifiers) if ((specifier.imported?.name ?? literal(specifier.imported)) === exported) {
      if (!id(specifier.local, exported)) fail('aliased activation constructor: ' + exported);
      importers.push(path);
    }
  }
  if (!isDeepStrictEqual(sorted(importers), [...expectedImporters].sort()) || importers.length !== expectedImporters.length) fail('activation constructor importer census differs: ' + exported);
  const constructions = [];
  for (const [path, source] of parsed) for (const node of source.nodes) if (id(node, exported)) {
    const parent = source.parent(node);
    if (parent?.type === 'ImportSpecifier' || parent?.type === 'ClassDeclaration' && parent.id === node) continue;
    if (parent?.type === 'NewExpression' && parent.callee === node) { constructions.push({ path, node: parent }); continue; }
    fail('activation constructor escapes or has an unknown alias: ' + exported);
  }
  return constructions;
}

function directCalls(parsed, memberName) {
  return parsed.nodes.filter(node => node.type === 'MemberExpression' && self(node, memberName)).map(reference => {
    const call = parsed.parent(reference);
    if (reference.computed || call?.type !== 'CallExpression' || unwrap(call.callee) !== reference) fail('activation member is computed or escapes: ' + memberName);
    return call;
  });
}

function eventBinding(parsed, owner, call, label, actionName) {
  const templates = parsed.nodes.filter(node => node.type === 'TaggedTemplateExpression' && inside(node, owner) && id(node.tag, 'html'));
  const matches = [];
  for (const template of templates) for (const [index, expression] of template.quasi.expressions.entries()) {
    if (!inside(call, expression) || expression.type !== 'ArrowFunctionExpression') continue;
    let prefix = '';
    for (let at = 0; at <= index; at++) prefix += template.quasi.quasis[at].value.raw + (at < index ? '${value}' : '');
    const after = template.quasi.quasis[index + 1].value.raw;
    if (!/<en-button\b[^<>]*\s@click=$/.test(prefix.slice(prefix.lastIndexOf('<en-button'))) || !after.startsWith('>' + label + '</en-button>')) fail('activation is not the exact plain button event value');
    const dispatch = unwrap(expression.body);
    if (dispatch?.type !== 'CallExpression' || !self(dispatch.callee, actionName) || literal(dispatch.arguments[1]) !== label || dispatch.arguments[2]?.type !== 'ArrowFunctionExpression' || unwrap(dispatch.arguments[2].body) !== call) fail('activation event forwarding differs');
    let value = template;
    for (;;) {
      const parent = parsed.parent(value);
      if (parent?.type === 'ConditionalExpression' && [parent.consequent, parent.alternate].includes(value)) { value = parent; continue; }
      if (parent?.type === 'TemplateLiteral' && parent.expressions.includes(value)) {
        const tag = parsed.parent(parent);
        if (tag?.type !== 'TaggedTemplateExpression' || !id(tag.tag, 'html')) fail('native event template reaches an unknown tag');
        value = tag; continue;
      }
      if (parent?.type !== 'ReturnStatement' || parent.argument !== value || parsed.parent(parent) !== owner.value.body) fail('native event template escapes its render return');
      break;
    }
    matches.push({ start: expression.start, end: expression.end, event: 'click', label });
  }
  return exact(matches, 'activation event binding is absent or ambiguous');
}

function htmlBinding(parsed) {
  const declarations = parsed.root.body.filter(node => node.type === 'ImportDeclaration' && literal(node.source) === 'lit' && node.specifiers.some(item => item.type === 'ImportSpecifier' && id(item.local, 'html') && id(item.imported, 'html')));
  exact(declarations, 'Lit html binding is absent or shadowed');
  for (const node of parsed.nodes) if (id(node, 'html')) {
    const parent = parsed.parent(node);
    if (parent?.type === 'ImportSpecifier' || parent?.type === 'TaggedTemplateExpression' && parent.tag === node) continue;
    fail('Lit template tag is rebound or escapes');
  }
}

function constructorCensus(parsed) {
  const global = node => ['globalThis', 'window', 'self'].some(name => id(node, name));
  for (const node of parsed.nodes) {
    if (id(node, 'Worker')) {
      const parent = parsed.parent(node);
      if (parent?.type === 'NewExpression' && unwrap(parent.callee) === node) continue;
      fail('Worker constructor is aliased, replaced, or escapes');
    }
    if (node.type === 'MemberExpression' && global(node.object) && (node.computed || key(node) === 'Worker')) fail('computed/global Worker constructor access has no exact binding');
  }
}

// Names alone are not bindings: a URL field in one method must not taint a
// same-named callback parameter in another. This finite census resolves module,
// function/parameter, block, loop, catch and class bindings before following
// local value transfers. It remains subordinate to the exact reviewed corpus;
// it is not an inter-module effect proof for arbitrary consumers of data.
function ownerBindings(source) {
  const functions = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
  const scopeTypes = new Set(['Program', ...functions, 'BlockStatement', 'StaticBlock', 'CatchClause', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'SwitchStatement', 'ClassDeclaration', 'ClassExpression']);
  const scopes = new Map(), all = [];
  let remaining = 2_000_000;
  const step = () => { if (--remaining < 0) fail('owner value-resolution work bound exceeded'); };
  const scope = node => {
    if (!node) return null;
    if (scopes.has(node)) return scopes.get(node);
    const parent = scope(source.parents.get(node));
    const value = scopeTypes.has(node.type) ? { node, parent, names: new Map(), variable: node.type === 'Program' || node.type === 'StaticBlock' || functions.has(node.type) } : parent;
    scopes.set(node, value); return value;
  };
  const identifiers = node => {
    node = unwrap(node);
    if (!node) return [];
    if (node.type === 'Identifier') return [node];
    if (node.type === 'ObjectPattern') return node.properties.flatMap(item => identifiers(item.type === 'RestElement' ? item.argument : item.value));
    if (node.type === 'ArrayPattern') return node.elements.flatMap(identifiers);
    if (node.type === 'AssignmentPattern') return identifiers(node.left);
    if (node.type === 'RestElement') return identifiers(node.argument);
    if (node.type === 'TSParameterProperty') return identifiers(node.parameter);
    fail('owner binding pattern is unsupported');
  };
  const bind = (at, pattern, kind, value) => {
    if (!at) fail('owner declaration has no lexical scope');
    for (const name of identifiers(pattern)) {
      let binding = at.names.get(name.name);
      if (binding && !([kind, ...binding.kinds].every(item => ['var', 'function', 'parameter'].includes(item)) && at.variable)) fail('owner binding is duplicated or ambiguous: ' + name.name);
      if (!binding) { binding = { name: name.name, scope: at, kinds: new Set(), values: new Set() }; at.names.set(name.name, binding); all.push(binding); }
      binding.kinds.add(kind); if (value) binding.values.add(value);
    }
  };
  const variableScope = at => { while (at && !at.variable) at = at.parent; return at; };
  const declarationScope = node => {
    const parent = source.parents.get(node), at = scope(parent);
    // Function-body declarations share the function's var/parameter environment;
    // a declaration in any nested block stays in that block (module strict mode).
    return parent?.type === 'BlockStatement' && functions.has(source.parents.get(parent)?.type) ? at.parent : at;
  };
  for (const node of source.nodes) {
    if (node.type === 'VariableDeclarator') {
      const declaration = source.parent(node); if (declaration?.type !== 'VariableDeclaration') fail('owner declaration kind is unresolved');
      bind(declaration.kind === 'var' ? variableScope(scope(node)) : scope(node), node.id, declaration.kind, node.init);
    } else if (node.type === 'FunctionDeclaration') bind(declarationScope(node), node.id, 'function', node);
    else if (node.type === 'FunctionExpression' && node.id) bind(scope(node), node.id, 'function-name', node);
    else if (node.type === 'ClassDeclaration') bind(scope(source.parents.get(node)), node.id, 'class', node);
    else if (node.type === 'ClassExpression' && node.id) bind(scope(node), node.id, 'class-name', node);
    else if (['ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(node.type)) bind(scope(node), node.local, 'import', null);
    else if (node.type === 'CatchClause' && node.param) bind(scope(node), node.param, 'catch', null);
    if (functions.has(node.type)) for (const parameter of node.params) bind(scope(node), parameter, 'parameter', unwrap(parameter)?.type === 'AssignmentPattern' ? unwrap(parameter).right : null);
  }
  const resolve = node => {
    node = unwrap(node); if (node?.type !== 'Identifier') return null;
    for (let at = scope(node); at; at = at.parent) if (at.names.has(node.name)) return at.names.get(node.name);
    return null;
  };
  let bindingChanged = () => {};
  const add = (pattern, value) => {
    let changed = false;
    for (const name of identifiers(pattern)) {
      step(); const binding = resolve(name); if (!binding) fail('written owner binding is unresolved: ' + name.name);
      if (!binding.values.has(value)) { binding.values.add(value); bindingChanged(binding, value); changed = true; }
    }
    return changed;
  };
  // Assignment patterns may write properties; declaration/parameter patterns
  // may not. Project literal destructuring sources to their leaves, preserving
  // both lexical assignments and member writes instead of inventing bindings.
  const memberAssignments = [];
  const assignment = (target, value, origin) => {
    target = unwrap(target); value = unwrap(value); step(); if (!target) return;
    if (target.type === 'AssignmentPattern') { assignment(target.left, value, origin); assignment(target.left, target.right, origin); return; }
    if (!value) return;
    if (target.type === 'Identifier') { add(target, value); return; }
    if (target.type === 'MemberExpression') { memberAssignments.push({ target, value, origin }); return; }
    if (target.type === 'ArrayPattern' && value.type === 'ArrayExpression' && !value.elements.some(item => { step(); return item?.type === 'SpreadElement'; })) {
      for (const [index, item] of target.elements.entries()) {
        if (item?.type === 'RestElement') for (const rest of value.elements.slice(index)) assignment(item.argument, rest, origin);
        else assignment(item, value.elements[index], origin);
      }
      return;
    }
    if (target.type === 'ObjectPattern' && value.type === 'ObjectExpression' && value.properties.every(item => { step(); return item.type === 'Property' && item.kind === 'init' && key(item) !== null; })) {
      for (const item of target.properties) {
        if (item.type === 'RestElement') { for (const property of value.properties) assignment(item.argument, property.value, origin); }
        else {
          if (key(item) === null) fail('computed assignment projection is unresolved');
          const selected = value.properties.filter(property => { step(); return key(property) === key(item); });
          if (!selected.length) assignment(item.value, null, origin);
          for (const property of selected) assignment(item.value, property.value, origin);
        }
      }
      return;
    }
    // Keep existing identifier-only pattern treatment; an unknown member-source
    // projection remains refused by the strict declaration-pattern reader.
    add(target, value);
  };
  for (const node of source.nodes) if (node.type === 'AssignmentExpression' && ['Identifier', 'ObjectPattern', 'ArrayPattern'].includes(unwrap(node.left)?.type)) assignment(node.left, node.right, node);
  const returns = new Map(source.nodes.filter(node => functions.has(node.type)).map(fn => [fn, fn.type === 'ArrowFunctionExpression' && fn.body.type !== 'BlockStatement' ? [fn.body] : []]));
  for (const node of source.nodes) if (node.type === 'ReturnStatement' && node.argument) {
    let parent = source.parents.get(node); while (parent && !functions.has(parent.type)) parent = source.parents.get(parent);
    if (parent) returns.get(parent).push(node.argument);
  }
  // A member call can forward into any matching local member. Keep that
  // conservative union instead of guessing a receiver's runtime class. Literal
  // property values, getters and later writes participate; unknown computed
  // names are a wildcard. Imported/external consumer effects still require the
  // separately verified full-corpus contract.
  const members = new Map();
  const member = (name, values) => {
    const prior = members.get(name) ?? new Set(); for (const value of values) if (value) prior.add(value); members.set(name, prior);
  };
  for (const node of source.nodes) {
    if (node.type === 'MethodDefinition' || node.type === 'PropertyDefinition' || node.type === 'Property' && source.parent(node)?.type === 'ObjectExpression') {
      if (node.kind !== 'set') member(key(node), node.kind === 'get' ? returns.get(node.value) ?? [] : [node.value]);
    } else if (node.type === 'AssignmentExpression' && unwrap(node.left)?.type === 'MemberExpression') member(key(unwrap(node.left)), [node.right]);
    if (node.type === 'ThrowStatement' && node.argument) {
      for (let at = source.parents.get(node); at; at = source.parents.get(at)) {
        if (functions.has(at.type)) break;
        if (at.type === 'TryStatement' && at.handler?.param && inside(node, at.block)) { add(at.handler.param, node.argument); break; }
      }
    }
  }
  for (const { target, value } of memberAssignments) member(key(target), [value]);
  const memberValues = node => [...(members.get(key(node)) ?? []), ...(key(node) === null ? [] : members.get(null) ?? [])];
  // Return graphs can be cyclic even for ordinary scalar data (for example a
  // recursive JSON parser feeding a computed property). Solve the finite target
  // equations monotonically. An empty node keeps its dependency edges, so a
  // later function/argument seed propagates through the entire cycle.
  const targetCells = new Map(), bindingReaders = new Map(), pendingTargets = [], queuedTargets = new Set();
  const enqueue = cell => { if (!queuedTargets.has(cell)) { queuedTargets.add(cell); pendingTargets.push(cell); } };
  const cellFor = node => {
    node = unwrap(node); if (!node) return null;
    let cell = targetCells.get(node);
    if (!cell) {
      step(); cell = { node, expanded: false, targets: new Set(), inputs: new Set(), users: new Set(), callee: null, returnsAdded: new Set() };
      targetCells.set(node, cell); enqueue(cell);
    }
    return cell;
  };
  const dependency = (cell, node) => {
    const input = cellFor(node);
    if (input && !cell.inputs.has(input)) { step(); cell.inputs.add(input); input.users.add(cell); enqueue(cell); }
  };
  bindingChanged = (binding, value) => {
    for (const cell of bindingReaders.get(binding) ?? []) dependency(cell, value);
  };
  const targets = root => {
    step(); const result = cellFor(root); if (!result) return [];
    while (pendingTargets.length) {
      const cell = pendingTargets.pop(); queuedTargets.delete(cell); step();
      const node = cell.node; let changed = false;
      const include = fn => { step(); if (!cell.targets.has(fn)) { cell.targets.add(fn); changed = true; } };
      if (!cell.expanded) {
        cell.expanded = true;
        if (functions.has(node.type)) include(node);
        else if (['ClassDeclaration', 'ClassExpression'].includes(node.type)) { for (const member of node.body.body) if (member.type === 'MethodDefinition' && member.kind === 'constructor') dependency(cell, member.value); }
        else if (node.type === 'MemberExpression' && !node.computed) { for (const value of memberValues(node)) dependency(cell, value); }
        else if (node.type === 'Identifier') {
          const binding = resolve(node);
          if (binding) {
            const readers = bindingReaders.get(binding) ?? new Set(); readers.add(cell); bindingReaders.set(binding, readers);
            for (const value of binding.values) dependency(cell, value);
          }
        } else if (node.type === 'ConditionalExpression') { dependency(cell, node.consequent); dependency(cell, node.alternate); }
        else if (node.type === 'LogicalExpression') { dependency(cell, node.left); dependency(cell, node.right); }
        else if (node.type === 'SequenceExpression') dependency(cell, node.expressions.at(-1));
        else if (node.type === 'AssignmentExpression') dependency(cell, node.right);
        else if (node.type === 'AwaitExpression') dependency(cell, node.argument);
        else if (node.type === 'CallExpression') {
          cell.callee = cellFor(node.callee);
          if (cell.callee) { step(); cell.callee.users.add(cell); }
        }
      }
      if (cell.callee) for (const fn of cell.callee.targets) {
        step(); if (cell.returnsAdded.has(fn)) continue;
        cell.returnsAdded.add(fn);
        for (const value of returns.get(fn) ?? []) dependency(cell, value);
      }
      for (const input of cell.inputs) for (const fn of input.targets) include(fn);
      if (changed) for (const user of cell.users) enqueue(user);
    }
    const found = []; for (const fn of result.targets) { step(); found.push(fn); }
    return found;
  };
  // Bind local calls by declaration identity, including IIFEs and captured
  // function aliases. All possible writes/arguments remain in the union; a
  // later scalar assignment never erases an earlier callable value.
  const calls = source.nodes.filter(node => ['CallExpression', 'NewExpression', 'TaggedTemplateExpression'].includes(node.type));
  for (let pass = 0; pass <= source.nodes.length; pass++) {
    let changed = false;
    for (const call of calls) {
      const callee = unwrap(call.type === 'TaggedTemplateExpression' ? call.tag : call.callee);
      if (callee?.type === 'MemberExpression' && ['call', 'apply', 'bind'].includes(key(callee)) && targets(callee.object).length) fail('local callable forwarding is unresolved');
      const arguments_ = call.type === 'TaggedTemplateExpression' ? [call.quasi, ...call.quasi.expressions] : call.arguments;
      for (const fn of targets(callee)) for (const [index, parameter] of fn.params.entries()) {
        const args = arguments_.some(value => value.type === 'SpreadElement') || unwrap(parameter)?.type === 'RestElement' ? arguments_.slice(unwrap(parameter)?.type === 'RestElement' ? index : 0) : arguments_.slice(index, index + 1);
        for (const argument of args) if (add(parameter, argument.type === 'SpreadElement' ? argument.argument : argument)) changed = true;
      }
    }
    if (!changed) break;
    if (pass === source.nodes.length) fail('owner argument census did not settle');
  }
  // Static property writes also carry computed-value provenance. Keep their
  // receiver identity separate from the broad member target union: reordering
  // array entries must not label every unrelated method with the same name.
  const receiverIds = new Map(); let nextReceiverId = 0;
  const receiverId = value => { if (!receiverIds.has(value)) receiverIds.set(value, ++nextReceiverId); return receiverIds.get(value); };
  const receivers = root => {
    const found = new Set(), seen = new Map(), pending = [[root, []]];
    while (pending.length) {
      let [node, suffix] = pending.pop(); node = unwrap(node); if (!node) continue; step();
      const path = JSON.stringify(suffix), prior = seen.get(node) ?? new Set(); if (prior.has(path)) continue; prior.add(path); seen.set(node, prior);
      if (path.length > 4096) fail('member receiver path is unresolved');
      if (node.type === 'Identifier') {
        const binding = resolve(node); found.add((binding ? 'b' + receiverId(binding) : 'g' + node.name) + path);
        for (const value of binding?.values ?? []) pending.push([value, suffix]);
      } else if (node.type === 'MemberExpression' && key(node) !== null) pending.push([node.object, [String(key(node)), ...suffix]]);
      else if (node.type === 'ThisExpression') {
        let at = source.parents.get(node); while (at && !['ClassDeclaration', 'ClassExpression'].includes(at.type)) at = source.parents.get(at);
        if (!at) fail('member receiver this binding is unresolved'); found.add('t' + receiverId(at) + path);
      } else if (['ObjectExpression', 'ArrayExpression', 'NewExpression'].includes(node.type)) {
        found.add('v' + receiverId(node) + path);
        if (suffix.length && node.type === 'ObjectExpression') for (const property of node.properties) {
          step();
          if (property.type === 'SpreadElement') pending.push([property.argument, suffix]);
          else if (key(property) === null || String(key(property)) === suffix[0]) {
            const values = property.kind === 'get' ? returns.get(property.value) ?? [] : [property.value];
            for (const value of values) pending.push([value, suffix.slice(1)]);
          }
        }
        if (suffix.length && node.type === 'ArrayExpression' && /^(0|[1-9][0-9]*)$/.test(suffix[0])) {
          const index = Number(suffix[0]);
          if (node.elements.some(item => { step(); return item?.type === 'SpreadElement'; })) fail('spread receiver index is unresolved');
          if (Number.isSafeInteger(index) && index < node.elements.length) pending.push([node.elements[index], suffix.slice(1)]);
        }
      } else if (node.type === 'CallExpression') { for (const fn of targets(node.callee)) for (const value of returns.get(fn) ?? []) pending.push([value, suffix]); }
      else if (node.type === 'ConditionalExpression') pending.push([node.consequent, suffix], [node.alternate, suffix]);
      else if (node.type === 'LogicalExpression') pending.push([node.left, suffix], [node.right, suffix]);
      else if (node.type === 'AssignmentExpression') pending.push([node.right, suffix]);
      else if (node.type === 'SequenceExpression') pending.push([node.expressions.at(-1), suffix]);
      else if (node.type === 'AwaitExpression') pending.push([node.argument, suffix]);
    }
    return found;
  };
  const staticWrites = memberAssignments.filter(({ target }) => key(target) !== null).map(({ target, value }) => {
    const owners = receivers(target.object); if (!owners.size) fail('member assignment receiver is unresolved');
    return { name: key(target), owners, value };
  });
  const assignedMemberValues = node => {
    if (key(node) === null || !staticWrites.length) return [];
    const owners = receivers(node.object), values = [];
    for (const write of staticWrites) { step(); if (write.name === key(node) && [...write.owners].some(owner => { step(); return owners.has(owner); })) values.push(write.value); }
    return values;
  };
  const conditionalAssignments = [...new Set(memberAssignments.filter(({ target }) => key(target) === null).map(({ origin }) => origin))];
  return { all, resolve, targets, returns, step, assignedMemberValues, conditionalAssignments };
}

function opaqueOwnerCensus(source) {
  const bindings = ownerBindings(source), domBindings = new Set(), callableBindings = new Set(), callableNames = new Set();
  const conditionalDOMReads = [];
  const value = (root, kind) => {
    const seen = new Set(), pending = [root];
    while (pending.length) {
      const node = unwrap(pending.pop()); if (!node || seen.has(node)) continue;
      seen.add(node); bindings.step();
      if (node.type === 'Identifier' && (kind === 'dom' ? domBindings : callableBindings).has(bindings.resolve(node))) return true;
      if (node.type === 'MemberExpression') {
        if (kind === 'callable' && node.computed || kind === 'dom' && self(node, 'host')) return true;
        if (kind === 'dom') pending.push(node.object);
        pending.push(...bindings.assignedMemberValues(node));
      } else if (node.type === 'CallExpression') {
        if (kind === 'dom' && ['querySelector', 'querySelectorAll', 'getElementById', 'closest', 'getElementsByTagName', 'getElementsByClassName'].includes(key(unwrap(node.callee)))) return true;
        for (const fn of bindings.targets(node.callee)) pending.push(...(bindings.returns.get(fn) ?? []));
      } else if (node.type === 'ConditionalExpression') pending.push(node.consequent, node.alternate);
      else if (node.type === 'LogicalExpression') pending.push(node.left, node.right);
      else if (node.type === 'SequenceExpression') pending.push(node.expressions.at(-1));
      else if (node.type === 'AssignmentExpression') pending.push(node.right);
      else if (node.type === 'AwaitExpression') pending.push(node.argument);
    }
    return false;
  };
  for (let pass = 0; pass <= source.nodes.length; pass++) {
    let changed = false;
    for (const binding of bindings.all) {
      if (!domBindings.has(binding) && [...binding.values].some(node => value(node, 'dom'))) { domBindings.add(binding); changed = true; }
      if (!callableBindings.has(binding) && [...binding.values].some(node => value(node, 'callable'))) { callableBindings.add(binding); callableNames.add(binding.name); changed = true; }
    }
    if (!changed) break;
    if (pass === source.nodes.length) fail('owner alias census did not settle');
  }
  for (const node of source.nodes) {
    if (node.type === 'MemberExpression' && node.computed && value(node.object, 'dom')) {
      const parent = source.parent(node), index = literal(node.property);
      // This does not erase DOM taint or grant a property-name exemption. A
      // literal index observed only by equality can carry an explicit data-read
      // obligation. Final admission must discharge its exact source and pinned
      // producer effect; dynamic keys, invocation and other uses still refuse.
      if (!Number.isSafeInteger(index) || index < 0 || parent?.type !== 'BinaryExpression' || !['===', '!=='].includes(parent.operator) || ![parent.left, parent.right].includes(node)) fail('computed DOM/controller ownership is unresolved');
      conditionalDOMReads.push({ source: source.path, start: node.start, end: node.end,
        sourceSha256: hash(source.text), expressionSha256: hash(source.text.slice(node.start, node.end)), requirement: 'reviewed-dom-data-read' });
    }
    if (['CallExpression', 'NewExpression', 'TaggedTemplateExpression'].includes(node.type)) {
      const callee = unwrap(node.type === 'TaggedTemplateExpression' ? node.tag : node.callee);
      if (value(callee, 'callable') || callee?.type === 'Identifier' && !bindings.resolve(callee) && callableNames.has(callee.name)) fail('computed callable alias is unresolved');
    }
    if (node.type === 'MemberExpression' && ['call', 'apply', 'bind'].includes(key(node))) {
      if (value(node.object, 'callable')) fail('computed callable alias is unresolved');
      if (bindings.targets(node.object).length) fail('local callable forwarding is unresolved');
    }
  }
  // Computed property writes are not generically declared safe. Their exact
  // source effects remain conditional until final admission discharges every
  // row using the independently reviewed whole-corpus contract.
  return { memberAssignments: bindings.conditionalAssignments.map(node => ({ source: source.path, start: node.start, end: node.end,
    sourceSha256: hash(source.text), assignmentSha256: hash(source.text.slice(node.start, node.end)), requirement: 'reviewed-data-only-array-reordering' })), domReads: conditionalDOMReads };
}

function ownReceiver(parsed, owner, name, creation, activatingMethod) {
  const field = owner.members.get(name);
  if (!field || field.type !== 'PropertyDefinition' || field.value) fail('activation receiver is not initially absent: ' + name);
  const activations = [];
  for (const node of parsed.nodes) if (self(node, name)) {
    if (node.computed) fail('computed activation receiver: ' + name);
    const parent = parsed.parent(node);
    if (parent?.type === 'AssignmentExpression' && parent.left === node && parent.operator === '=') {
      if (id(parent.right, 'undefined')) continue;
      if (parent.right?.type === 'NewExpression' && id(parent.right.callee, creation) && key(owner.owner(parent)) === activatingMethod) continue;
      fail('activation receiver has an alternate assignment: ' + name);
    }
    if (parent?.type === 'ConditionalExpression' && parent.test === node && name === 'preparation') continue;
    if (parent?.type !== 'MemberExpression' || parent.computed) fail('activation receiver escapes: ' + name);
    if (key(parent) === 'lifecycle' && name === 'renderer') continue;
    const call = parsed.parent(parent);
    if (call?.type !== 'CallExpression' || unwrap(call.callee) !== parent || !['prepare', 'cancel', 'dispose'].includes(key(parent))) fail('activation receiver operation is unknown: ' + name);
    if (key(parent) === 'prepare') {
      if (key(owner.owner(call)) !== activatingMethod) fail('activation receiver prepares from another entry: ' + name);
      activations.push(call);
    }
  }
  return exact(activations, 'activation receiver prepare binding differs: ' + name);
}

function controllerOwnership(parsed, construction) {
  const shell = parsed.get(PATHS.shell), owner = klass(shell, 'EditorShell', true), factory = owner.method('createNativeTextEditing');
  if (!id(owner.node.superClass, 'LitElement') || !shell.root.body.some(node => node.type === 'ImportDeclaration' && literal(node.source) === 'lit' && node.specifiers.some(item => item.type === 'ImportSpecifier' && id(item.local, 'LitElement') && id(item.imported, 'LitElement')))) fail('shell does not use the reviewed Lit lifecycle');
  if (factory.value.body.body.length !== 1 || factory.value.body.body[0].type !== 'ReturnStatement' || factory.value.body.body[0].argument !== construction) fail('native controller factory escapes its exact allocation');
  const factoryCalls = directCalls(shell, 'createNativeTextEditing');
  if (!isDeepStrictEqual(factoryCalls.map(call => key(owner.owner(call))).sort(), ['restoreRetiredControllers', 'textEditing'])) fail('native controller factory caller census differs');
  if (directCalls(parsed.get(PATHS.native), 'render').length) fail('native template has an unreviewed local consumer');
  const methods = new Set(['beginFromReturnedDescription', 'dispose', 'releaseDocument', 'sync', 'overlay', 'begin', 'render']);
  for (const [path, source] of parsed) for (const node of source.nodes) {
    if (node.type === 'Property' && source.parent(node)?.type === 'ObjectPattern') {
      if (node.computed) fail('computed owner destructuring prevents a closed activation census');
      if (key(node) === 'textEditing' && !(path === PATHS.shell && key(owner.owner(node)) === 'disconnectedCallback' && id(node.value, 'textEditing'))) fail('native controller is extracted by an external object pattern');
      if (['preparePreview', 'createNativeTextEditing', 'renderer', 'preparation'].includes(key(node))) fail('native activation capability is extracted by an object pattern');
    }
    if ((node.type === 'CallExpression' || node.type === 'NewExpression') && unwrap(node.callee)?.type === 'MemberExpression' && unwrap(node.callee).computed) fail('computed callable prevents a closed activation census');
    if (node.type === 'AssignmentExpression' && unwrap(node.left)?.type === 'MemberExpression' && ['preview', 'renderer', 'preparation'].includes(key(unwrap(node.left))) && unwrap(unwrap(node.left).object)?.type !== 'ThisExpression') fail('native state can be written through an external receiver');
    if (node.type !== 'MemberExpression') continue;
    if (key(node) === 'preparePreview' && path !== PATHS.native || ['createNativeTextEditing', 'textEditing'].includes(key(node)) && path !== PATHS.shell) fail('native controller is accessed from an unreviewed owner');
    if (path !== PATHS.shell || !self(node, 'textEditing')) continue;
    if (node.computed) fail('native controller ownership is computed');
    const parent = source.parent(node), method = key(owner.owner(node));
    if (parent?.type === 'AssignmentExpression' && parent.left === node && parent.operator === '=' && parent.right?.type === 'CallExpression' && self(parent.right.callee, 'createNativeTextEditing') && method === 'restoreRetiredControllers') continue;
    if (parent?.type === 'BinaryExpression' && parent.operator === '===' && method === 'restoreRetiredControllers') continue;
    if (parent?.type !== 'MemberExpression' || parent.computed) fail('native controller has an unproved receiver alias');
    if (['active', 'composing', 'lifecycle'].includes(key(parent))) continue;
    const call = source.parent(parent);
    if (!methods.has(key(parent)) || call?.type !== 'CallExpression' || unwrap(call.callee) !== parent) fail('native controller has an unproved operation');
    if (key(parent) === 'render') {
      const template = source.parent(call), tag = template && source.parent(template);
      if (template?.type !== 'TemplateLiteral' || !template.expressions.includes(call) || tag?.type !== 'TaggedTemplateExpression' || !id(tag.tag, 'html') || method !== 'render') fail('native render result escapes its Lit consumer');
    }
  }
  // The one teardown destructure owns disposal and the retired-controller
  // comparison only. A renamed alias, callable extraction, or returned owner
  // would expose ordinary TypeScript-private preview/renderer fields.
  for (const node of shell.nodes) if (id(node, 'textEditing')) {
    const parent = shell.parent(node), method = key(owner.owner(node));
    if (parent?.type === 'PropertyDefinition' && parent.key === node || parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) continue;
    if (method !== 'disconnectedCallback') fail('native controller alias escapes teardown');
    if (parent?.type === 'Property' && key(parent) === 'textEditing' && shell.parent(parent)?.type === 'ObjectPattern' && id(parent.value, 'textEditing')) continue;
    if (parent?.type === 'Property' && key(parent) === 'text' && parent.value === node && shell.parent(parent)?.type === 'ObjectExpression') {
      const assignment = shell.parent(shell.parent(parent));
      if (assignment?.type === 'AssignmentExpression' && self(assignment.left, 'retiredControllers')) continue;
    }
    if (parent?.type === 'MemberExpression' && parent.object === node && key(parent) === 'dispose' && shell.parent(parent)?.type === 'CallExpression') continue;
    fail('native teardown alias has an unproved use');
  }
  for (const node of shell.nodes) if (self(node, 'retiredControllers')) {
    const parent = shell.parent(node), method = key(owner.owner(node));
    if (parent?.type === 'AssignmentExpression' && parent.left === node && parent.operator === '=' && (id(parent.right, 'undefined') && method === 'restoreRetiredControllers' || parent.right.type === 'ObjectExpression' && method === 'disconnectedCallback')) continue;
    if (parent?.type === 'VariableDeclarator' && parent.init === node && id(parent.id, 'prior') && method === 'restoreRetiredControllers') continue;
    fail('retired native controller ownership escapes');
  }
  for (const node of shell.nodes) if (node.type === 'MemberExpression' && id(node.object, 'prior') && key(node) === 'text' && inside(node, owner.method('restoreRetiredControllers'))) {
    if (node.computed || shell.parent(node)?.type !== 'BinaryExpression' || shell.parent(node).operator !== '===') fail('retired native controller has an unproved alias');
  }
}

/** This is a provisional application-AST proof only. It never returns an
 * exclusion and never substitutes for archive-bound invocation effects or the
 * whole-corpus activation census. No source hash is an admission whitelist. */
export function deriveD11NativePreparationClosure({ sourceTextByPath, parser } = {}) {
  const missing = [], finish = value => ({ kind: 'd11-native-preparation-closure-1', complete: !missing.length, missing, ...value });
  try {
    if (parser?.name !== 'rolldown' || typeof parser.parseSync !== 'function' || typeof parser.version !== 'string') fail('pinned AST parser is unavailable');
    if (!sourceTextByPath || typeof sourceTextByPath !== 'object') fail('retained application sources are absent');
    const parsed = new Map();
    for (const path of Object.keys(sourceTextByPath).filter(path => /\.[cm]?[jt]sx?$/.test(path) && !/\.d\.ts$/.test(path)).sort()) parsed.set(path, parse(path, sourceTextByPath[path], parser));
    for (const path of Object.values(PATHS)) if (!parsed.has(path)) fail('required source is absent: ' + path);
    const conditionalSites = [], conditionalDOMSites = [];
    for (const source of parsed.values()) {
      constructorCensus(source); const census = opaqueOwnerCensus(source);
      conditionalSites.push(...census.memberAssignments); conditionalDOMSites.push(...census.domReads);
    }
    conditionalSites.sort((left, right) => left.source.localeCompare(right.source) || left.start - right.start);
    conditionalDOMSites.sort((left, right) => left.source.localeCompare(right.source) || left.start - right.start);
    const conditionalMemberEffects = { kind: 'd11-conditional-member-assignments-1', sites: conditionalSites };
    const conditionalDOMEffects = { kind: 'd11-conditional-dom-data-reads-1', sites: conditionalDOMSites };
    const native = parsed.get(PATHS.native), client = parsed.get(PATHS.client), durable = parsed.get(PATHS.durable);
    htmlBinding(native); htmlBinding(parsed.get(PATHS.shell));
    const n = klass(native, 'NativeTextEditing'), c = klass(client, 'TextRenderer'), d = klass(durable, 'DurableTextPreparation');
    const render = n.method('render'), preview = n.method('preparePreview'), apply = n.method('apply');
    for (const [source, owner] of [[native, n], [client, c], [durable, d]]) for (const node of source.nodes) {
      if (!inside(node, owner.node)) continue;
      if (node.type === 'ThisExpression') {
        const parent = source.parent(node);
        if (parent?.type !== 'MemberExpression' || unwrap(parent.object) !== node || ['constructor', '__proto__', 'prototype'].includes(key(parent))) fail('activation owner escapes or exposes its prototype');
        if (parent.computed) {
          if (source !== native || key(owner.owner(parent)) !== 'filesChanged' || !id(parent.property, 'key')) fail('computed activation owner access');
        }
      }
    }
    const fileCalls = directCalls(native, 'filesChanged');
    if (fileCalls.length !== 2 || !isDeepStrictEqual(fileCalls.map(call => literal(call.arguments[1])).sort(), ['files', 'licenses']) || fileCalls.some(call => !inside(call, render))) fail('computed file-key writes are not bound to the two literal event keys');
    const previewCalls = directCalls(native, 'preparePreview');
    const previewCall = exact(previewCalls, 'Preview has an alternate public or lifecycle caller');
    const event = eventBinding(native, render, previewCall, 'Preview text', 'action');
    const applyCalls = directCalls(native, 'apply');
    if (!isDeepStrictEqual(applyCalls.map(call => key(n.owner(call))).sort(), ['key', 'render', 'settle'])) fail('Apply caller census differs');
    eventBinding(native, render, exact(applyCalls.filter(call => inside(call, render)), 'Apply event is absent'), 'Apply text', 'action');
    const previewField = n.members.get('preview');
    if (previewField?.type !== 'PropertyDefinition' || previewField.value) fail('cold native preview state is not absent');
    const previewWrites = native.nodes.filter(node => node.type === 'AssignmentExpression' && self(node.left, 'preview'));
    const initializations = previewWrites.filter(node => !id(node.right, 'undefined'));
    if (initializations.length !== 1 || initializations[0].operator !== '=' || initializations[0].right.type !== 'ObjectExpression' || !inside(initializations[0], preview)) fail('native preview has an alternate initialization');
    const preparationTry = exact(apply.value.body.body.filter(node => node.type === 'TryStatement'), 'Apply preparation region differs');
    const guard = preparationTry.block.body[0], condition = guard?.test;
    if (guard?.type !== 'IfStatement' || condition?.type !== 'LogicalExpression' || condition.operator !== '||' ||
      condition.left?.type !== 'UnaryExpression' || condition.left.operator !== '!' || !self(condition.left.argument, 'preview') ||
      condition.right?.type !== 'BinaryExpression' || condition.right.operator !== '!==' || key(condition.right.left) !== 'revision' || !self(condition.right.left.object, 'preview') || !self(condition.right.right, 'revision') ||
      guard.consequent?.type !== 'ThrowStatement') fail('Apply does not synchronously reject a missing or stale preview');
    const rendererCall = ownReceiver(native, n, 'renderer', 'TextRenderer', 'preparePreview');
    const durableCall = ownReceiver(native, n, 'preparation', 'DurableTextPreparation', 'apply');
    if (!inside(durableCall, preparationTry.block) || durableCall.start <= guard.end || initializations[0].start <= rendererCall.end) fail('cold preview/Apply dominance differs');
    const rendererNews = bindingCensus(parsed, sourceTextByPath, PATHS.client, 'TextRenderer', [PATHS.native, PATHS.durable]);
    const durableNews = bindingCensus(parsed, sourceTextByPath, PATHS.durable, 'DurableTextPreparation', [PATHS.native]);
    const nativeNews = bindingCensus(parsed, sourceTextByPath, PATHS.native, 'NativeTextEditing', [PATHS.shell]);
    if (rendererNews.length !== 3 || rendererNews.some(({ path, node }) => path === PATHS.native ? !inside(node, preview) : path !== PATHS.durable || !['#renderer', 'prepare'].includes(key(d.owner(node))))) fail('renderer construction census differs');
    if (durableNews.length !== 1 || durableNews[0].path !== PATHS.native || !inside(durableNews[0].node, preparationTry.block) || durableNews[0].node.start <= guard.end) fail('durable construction escapes the preview gate');
    if (nativeNews.length !== 1 || nativeNews[0].path !== PATHS.shell) fail('native controller construction census differs');
    controllerOwnership(parsed, nativeNews[0].node);
    const durablePrepares = durable.nodes.filter(node => node.type === 'CallExpression' && key(node.callee) === 'prepare' && self(node.callee.object, '#renderer'));
    const durablePrepare = exact(durablePrepares, 'durable renderer prepare census differs');
    if (!inside(durablePrepare, d.method('prepare'))) fail('durable renderer prepares during construction');
    for (const node of durable.nodes) if (self(node, '#renderer')) {
      const parent = durable.parent(node);
      if (parent?.type === 'AssignmentExpression' && parent.left === node && parent.operator === '=' && parent.right.type === 'NewExpression' && id(parent.right.callee, 'TextRenderer') && inside(parent, d.method('prepare'))) continue;
      if (parent?.type === 'MemberExpression' && !parent.computed && ['prepare', 'cancel', 'dispose'].includes(key(parent)) && durable.parent(parent)?.type === 'CallExpression') continue;
      fail('durable renderer escapes or has an unknown alias');
    }
    const starts = directCalls(client, '#start');
    if (!isDeepStrictEqual(starts.map(call => key(c.owner(call))).sort(), ['#start', 'prepare'])) fail('Worker start has an alternate entry');
    if (directCalls(client, 'prepare').length) fail('renderer prepares from its own constructor or lifecycle');
    const schedule = exact(client.nodes.filter(node => node.type === 'CallExpression' && id(node.callee, 'queueMicrotask') && inside(node, c.method('prepare'))), 'prepare microtask forwarding differs');
    if (schedule.arguments[0]?.type !== 'ArrowFunctionExpression' || !inside(starts.find(call => inside(call, c.method('prepare'))), schedule.arguments[0])) fail('Worker start is not bound to the prepare microtask');
    const worker = exact(client.nodes.filter(node => node.type === 'NewExpression' && id(node.callee, 'Worker')), 'source Worker site is ambiguous');
    if (!inside(worker, c.method('#start')) || worker.arguments[0]?.type !== 'NewExpression' || !id(worker.arguments[0].callee, 'URL') || literal(worker.arguments[0].arguments[0]) !== './worker.ts' || worker.arguments[0].arguments.length !== 2 || !moduleURL(worker.arguments[0].arguments[1])) fail('source Worker site is not the exact cold renderer start');
    const workerModule = parsed.get(PATHS.worker), engineCall = exact(workerModule.nodes.filter(node => node.type === 'CallExpression' && id(node.callee, 'createTextEngine')), 'worker engine entry differs');
    const engineBinding = workerModule.parent(engineCall), engineDeclaration = engineBinding && workerModule.parent(engineBinding);
    if (engineBinding?.type !== 'VariableDeclarator' || engineBinding.init !== engineCall || engineDeclaration?.type !== 'VariableDeclaration' || workerModule.parent(engineDeclaration) !== workerModule.root) fail('worker engine entry is not eager module evaluation');
    const sourceInputs = [...parsed.keys()].sort().map(path => ({ path, rawBytes: Buffer.byteLength(sourceTextByPath[path]), sha256: hash(sourceTextByPath[path]) }));
    return finish({ source: PATHS.client, start: worker.start, end: worker.end, workerSource: PATHS.worker,
      witness: { kind: 'd11-native-preview-state-gate-1', sourceInputs, event, conditionalMemberEffects, conditionalDOMEffects,
        startup: ['constructor and instance fields', 'sync and restoreSession for any retained draft data', 'render and overlay', 'Open document', 'Save checkpoint'],
        coldState: 'preview absent; only the exact Preview click path initializes it',
        applyGate: { source: PATHS.native, start: guard.start, end: guard.end },
        activation: 'prepare -> Promise executor -> queueMicrotask -> #start -> module Worker; scheduling is eager once prepare is called',
        engine: 'worker evaluation starts createTextEngine before message dispatch; the full emitted engine/WASM graph remains independently accounted' } });
  } catch (error) { missing.push(error.message); return finish({}); }
}

/** A pure equality check, never an authority mint. Only final admission calls
 * it with a freshly verified invocation contract's full application profile. */
export function assertD11MemberAssignmentEffects(conditional, applicationSourceProfile) {
  const reviewed = applicationSourceProfile?.memberAssignmentEffects;
  if (conditional?.kind !== 'd11-conditional-member-assignments-1' || !isDeepStrictEqual(Object.keys(conditional).sort(), ['kind', 'sites']) || !Array.isArray(conditional.sites) || conditional.sites.length > 4096 ||
      applicationSourceProfile?.kind !== 'verified-d11-application-profile-1' || applicationSourceProfile.profile !== 'reviewed-d11-startup-corpus-1' ||
      !Array.isArray(applicationSourceProfile.inputs) || reviewed?.kind !== 'reviewed-d11-data-member-assignments-1' || !isDeepStrictEqual(Object.keys(reviewed).sort(), ['kind', 'sites']) || !Array.isArray(reviewed.sites) || reviewed.sites.length > 4096) fail('computed member effects lack the reviewed corpus contract');
  const keys = ['assignmentSha256', 'end', 'requirement', 'source', 'sourceSha256', 'start'];
  const sites = conditional.sites.map(row => {
    if (!row || !isDeepStrictEqual(Object.keys(row).sort(), keys) || typeof row.source !== 'string' || !Number.isSafeInteger(row.start) || !Number.isSafeInteger(row.end) || row.start < 0 || row.end <= row.start ||
        !/^sha256:[a-f0-9]{64}$/.test(row.sourceSha256) || !/^sha256:[a-f0-9]{64}$/.test(row.assignmentSha256) || row.requirement !== 'reviewed-data-only-array-reordering') fail('computed member obligation is malformed');
    const inputs = applicationSourceProfile.inputs.filter(input => input.path === row.source);
    if (inputs.length !== 1 || inputs[0].sha256 !== row.sourceSha256) fail('computed member obligation source is not reviewed');
    const { requirement, ...identity } = row; return { ...identity, effect: 'data-only-array-reordering' };
  });
  const ordered = rows => [...rows].sort((left, right) => left.source.localeCompare(right.source) || left.start - right.start);
  if (new Set(sites.map(row => row.source + ':' + row.start + ':' + row.end)).size !== sites.length || !isDeepStrictEqual(ordered(sites), ordered(reviewed.sites))) fail('computed member effects differ from the reviewed complete inventory');
  return sites;
}

/** Structural join only. Its caller must independently verify both the current
 * application profile and the installed/archive-bound producer effect. */
export function assertD11DOMDataEffects(conditional, applicationSourceProfile, invocationEffects) {
  const reviewed = applicationSourceProfile?.domDataEffects;
  if (conditional?.kind !== 'd11-conditional-dom-data-reads-1' || !isDeepStrictEqual(Object.keys(conditional).sort(), ['kind', 'sites']) || !Array.isArray(conditional.sites) || conditional.sites.length > 4096 ||
      applicationSourceProfile?.kind !== 'verified-d11-application-profile-1' || applicationSourceProfile.profile !== 'reviewed-d11-startup-corpus-1' || !Array.isArray(applicationSourceProfile.inputs) ||
      reviewed?.kind !== 'reviewed-d11-dom-data-reads-1' || !isDeepStrictEqual(Object.keys(reviewed).sort(), ['kind', 'sites']) || !Array.isArray(reviewed.sites) || reviewed.sites.length > 4096 ||
      invocationEffects?.treeSelectedKeys !== 'immutable-string-array-from-reviewed-value-model') fail('DOM data reads lack the reviewed producer contract');
  const keys = ['end', 'expressionSha256', 'requirement', 'source', 'sourceSha256', 'start'];
  const sites = conditional.sites.map(row => {
    if (!row || !isDeepStrictEqual(Object.keys(row).sort(), keys) || typeof row.source !== 'string' || !Number.isSafeInteger(row.start) || !Number.isSafeInteger(row.end) || row.start < 0 || row.end <= row.start ||
        !/^sha256:[a-f0-9]{64}$/.test(row.sourceSha256) || !/^sha256:[a-f0-9]{64}$/.test(row.expressionSha256) || row.requirement !== 'reviewed-dom-data-read') fail('DOM data-read obligation is malformed');
    const inputs = applicationSourceProfile.inputs.filter(input => input.path === row.source);
    if (inputs.length !== 1 || inputs[0].sha256 !== row.sourceSha256) fail('DOM data-read source is not reviewed');
    const { requirement, ...identity } = row; return { ...identity, effect: 'en-tree-selected-keys-zero-read' };
  });
  const ordered = rows => [...rows].sort((left, right) => left.source.localeCompare(right.source) || left.start - right.start);
  if (new Set(sites.map(row => row.source + ':' + row.start + ':' + row.end)).size !== sites.length || !isDeepStrictEqual(ordered(sites), ordered(reviewed.sites))) fail('DOM data reads differ from the reviewed complete inventory');
  return sites;
}

/** Exclude only the proved emitted Worker constructor site from startup
 * activation. No emitted file, class, engine dependency, or budget is removed. */
export function deriveD11WorkerActivation(args = {}) {
  const missing = [], excludedWorkers = [], finish = () => ({ excludedWorkers, complete: !missing.length, missing });
  try {
    if (!isDeepStrictEqual(args.roleContext, D11_ROLE_CONTEXT)) fail('fixed W0/W1 startup context differs');
    const proof = deriveD11NativePreparationClosure(args);
    if (!proof.complete) { missing.push(...proof.missing); return finish(); }
    const { files, outputTextByFile, parser } = args;
    if (!Array.isArray(files)) fail('emitted inventory is absent');
    const emittedModules = sorted(files.flatMap(file => file.modules ?? []));
    const invocation = verifyD11InvocationContract(args.invocationContract, { lock: args.lock, dependencyInputs: args.dependencyInputs, emittedModules, compilation: args.compilation, sourceTextByPath: args.sourceTextByPath, sourceInputs: args.sourceInputs, outputTextByFile: args.outputTextByFile });
    if (invocation.effects?.nativeEditingBridgeStartup !== 'no-preview-or-apply-dispatch') fail('native editing bridge invocation effect is not archive-bound');
    if (invocation.effects?.applicationSourceProfile !== 'reviewed-d11-startup-corpus-1' || invocation.applicationSourceProfile?.profile !== 'reviewed-d11-startup-corpus-1') fail('application ownership census is not bound to the reviewed current corpus');
    const memberAssignmentEffects = assertD11MemberAssignmentEffects(proof.witness.conditionalMemberEffects, invocation.applicationSourceProfile);
    const domDataEffects = assertD11DOMDataEffects(proof.witness.conditionalDOMEffects, invocation.applicationSourceProfile, invocation.effects);
    assertD11EventCorpus({ sourceTextByPath: args.sourceTextByPath, parser, requiredAbsentGlobals: invocation.requiredAbsentGlobals, applicationSourceProfile: invocation.applicationSourceProfile });
    for (const file of files.filter(file => file.kind === 'js')) constructorCensus(parse(file.file === 'inline:bootstrap' ? 'bootstrap.js' : file.file, outputTextByFile?.[file.file], parser));
    const importers = files.filter(file => file.kind === 'js' && [...file.sources ?? [], ...file.modules ?? []].includes(proof.source));
    const importer = exact(importers, 'source Worker has absent or ambiguous emitted importer');
    const output = parse(importer.file, outputTextByFile?.[importer.file], parser);
    const emitted = exact(output.nodes.filter(node => node.type === 'NewExpression' && id(node.callee, 'Worker')), 'emitted Worker binding is ambiguous');
    let emittedOwner = output.parent(emitted);
    while (emittedOwner && emittedOwner.type !== 'MethodDefinition') emittedOwner = output.parent(emittedOwner);
    if (!emittedOwner || emittedOwner.static || emittedOwner.kind !== 'method' || emittedOwner.computed || emittedOwner.key?.type !== 'PrivateIdentifier') fail('emitted Worker is not inside the bound private activation method');
    const url = unwrap(emitted.arguments[0]);
    if (url?.type !== 'NewExpression' || !id(url.callee, 'URL') || typeof literal(url.arguments[0]) !== 'string' || url.arguments.length !== 2 || !moduleURL(url.arguments[1])) fail('emitted Worker URL is not literal and relative to the importer module');
    const specifier = literal(url.arguments[0]);
    if (/[\\?#\x00-\x20]/.test(specifier) || !specifier.startsWith('/') && !specifier.startsWith('./') && !specifier.startsWith('../')) fail('emitted Worker URL is not local');
    const target = posix.normalize(specifier.startsWith('/') ? specifier.slice(1) : posix.join(posix.dirname(importer.file), specifier));
    if (target.startsWith('../') || !files.some(file => file.file === target && file.kind === 'js')) fail('emitted Worker target is absent');
    excludedWorkers.push({ source: proof.source, start: proof.start, end: proof.end, target, outputs: [importer.file],
      emittedSite: { file: importer.file, start: emitted.start, end: emitted.end }, reason: 'native-preview-state-gate',
      witness: { ...proof.witness, memberAssignmentEffects, domDataEffects, invocationProfile: invocation.profile, applicationSourceProfile: invocation.applicationSourceProfile, roleContext: args.roleContext } });
    return finish();
  } catch (error) { missing.push(error.message); return finish(); }
}
