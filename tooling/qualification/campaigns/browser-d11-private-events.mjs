import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { D11_ROLE_CONTEXT } from './browser-d11-registration.mjs';
import { verifyD11InvocationContract } from './browser-d11-invocation-contract.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const code = path => /\.[cm]?[jt]sx?$/.test(path) && !/\.d\.[cm]?ts$/.test(path);
const sorted = values => [...new Set(values)].sort();
const fail = reason => { throw Error('D11 private event proof: ' + reason); };
const one = (values, reason) => values.length === 1 ? values[0] : fail(reason);
const unwrap = node => {
  while (node && ['ChainExpression', 'ParenthesizedExpression', 'TSAsExpression', 'TSNonNullExpression', 'TSTypeAssertion'].includes(node.type)) node = node.expression;
  return node;
};
const literal = node => ['Literal', 'StringLiteral'].includes(node?.type) && typeof node.value === 'string' ? node.value : null;
const key = node => node?.computed ? literal(node.key) : node?.key?.name ?? literal(node?.key);
const member = node => node?.type === 'MemberExpression' ? node.computed ? literal(node.property) : node.property?.name : null;
const privateMember = node => node?.type === 'MemberExpression' && !node.computed && node.object?.type === 'ThisExpression' && node.property?.type === 'PrivateIdentifier';
const functionNode = node => ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node?.type);
const span = node => ({ start: node.start, end: node.end });

function tree(program) {
  const nodes = [], parents = new WeakMap(), pending = [[program, null]];
  while (pending.length) {
    const [node, parent] = pending.pop();
    if (!node || typeof node.type !== 'string') continue;
    if (nodes.length >= 2_000_000) fail('AST exceeds node bound');
    nodes.push(node); parents.set(node, parent);
    for (const [name, value] of Object.entries(node)) {
      if (['parent', 'tokens', 'comments', 'loc', 'range'].includes(name)) continue;
      if (Array.isArray(value)) { for (const child of value) if (object(child)) pending.push([child, node]); }
      else if (object(value)) pending.push([value, node]);
    }
  }
  return { program, nodes, parents };
}
function contains(root, node, parents) { for (let at = node; at; at = parents.get(at)) if (at === root) return true; return false; }
function ancestor(node, parents, predicate) { for (let at = parents.get(node); at; at = parents.get(at)) if (predicate(at)) return at; return null; }
function parseCorpus(sourceTextByPath, parser) {
  if (parser?.name !== 'rolldown' || typeof parser.parseSync !== 'function') fail('verified parser is absent');
  const corpus = new Map(); let total = 0;
  for (const [path, text] of Object.entries(sourceTextByPath ?? {})) {
    if (!path.startsWith('src/') || !code(path)) continue;
    if (typeof text !== 'string' || text.length > 64 * 1024 * 1024 || (total += text.length) > 256 * 1024 * 1024) fail('source corpus exceeds byte bound');
    const result = parser.parseSync(path, text, { lang: /\.[cm]?tsx?$/.test(path) ? 'ts' : 'js', sourceType: 'module' });
    if (result.errors?.length || result.program?.type !== 'Program') fail('cannot parse sealed source ' + path);
    corpus.set(path, { ...tree(result.program), text, path });
  }
  return corpus;
}
function resolveSource(from, specifier, corpus) {
  if (typeof specifier !== 'string' || !specifier.startsWith('.') || /[?#\\\x00-\x20]/.test(specifier)) fail('import is not an exact local source');
  const path = posix.normalize(posix.join(posix.dirname(from), specifier));
  return one(sorted([path, path.replace(/\.js$/, '.ts')].filter(value => corpus.has(value))), 'import source mapping is not unique');
}
function imported(context, local, packageName, exported) {
  const matches = context.program.body.filter(node => node.type === 'ImportDeclaration' && node.importKind !== 'type' && literal(node.source) === packageName && node.specifiers.some(specifier => specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type' && specifier.local.name === local && (specifier.imported.name ?? literal(specifier.imported)) === exported));
  if (matches.length !== 1) return false;
  assertStableBinding(context, local);
  return true;
}
function bindingNames(node) {
  if (!node) return [];
  if (node.type === 'Identifier') return [node.name];
  if (node.type === 'ObjectPattern') return node.properties.flatMap(item => bindingNames(item.type === 'RestElement' ? item.argument : item.value));
  if (node.type === 'ArrayPattern') return node.elements.flatMap(bindingNames);
  return bindingNames(node.type === 'AssignmentPattern' ? node.left : node.type === 'RestElement' ? node.argument : node.type === 'TSParameterProperty' ? node.parameter : null);
}
function assertStableBinding(context, name) {
  let declarations = 0;
  for (const node of context.nodes) {
    const bindings = node.type === 'VariableDeclarator' ? bindingNames(node.id) : ['ImportSpecifier','ImportDefaultSpecifier','ImportNamespaceSpecifier'].includes(node.type) ? bindingNames(node.local) : ['ClassDeclaration','ClassExpression','FunctionDeclaration','FunctionExpression'].includes(node.type) ? bindingNames(node.id) : node.type === 'CatchClause' ? bindingNames(node.param) : [];
    declarations += bindings.filter(value => value === name).length;
    if (functionNode(node)) declarations += node.params.flatMap(bindingNames).filter(value => value === name).length;
    let written = node.type === 'AssignmentExpression' ? node.left : node.type === 'UpdateExpression' || node.type === 'UnaryExpression' && node.operator === 'delete' ? node.argument : null;
    while (unwrap(written)?.type === 'MemberExpression') written = unwrap(written).object;
    if (written?.type === 'Identifier' && written.name === name) fail('reviewed import binding is reassigned: ' + name);
  }
  if (declarations !== 1) fail('reviewed import binding is shadowed: ' + name);
}
function importOwner(context, local, corpus) {
  assertStableBinding(context, local);
  const declaration = one(context.program.body.filter(node => node.type === 'ImportDeclaration' && node.importKind !== 'type' && node.specifiers.some(specifier => specifier.local.name === local && specifier.importKind !== 'type')), 'constructor lacks one runtime import');
  const specifier = one(declaration.specifiers.filter(item => item.local.name === local && item.type === 'ImportSpecifier'), 'constructor import is not a named binding');
  const path = resolveSource(context.path, literal(declaration.source), corpus), target = corpus.get(path);
  const exported = specifier.imported.name ?? literal(specifier.imported);
  const klass = one(target.program.body.filter(node => node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'ClassDeclaration' && node.declaration.id?.name === exported).map(node => node.declaration), 'callback consumer does not have one direct named class export');
  assertStableBinding(target, exported);
  return { context: target, klass };
}
function methodOwner(context, node) { return ancestor(node, context.parents, item => item.type === 'MethodDefinition'); }
function privateCalls(context, klass, name) {
  const references = context.nodes.filter(node => node.type === 'PrivateIdentifier' && node.name === name && contains(klass, node, context.parents));
  const calls = [];
  for (const reference of references) {
    const parent = context.parents.get(reference);
    if (parent?.type === 'MethodDefinition' && parent.key === reference) continue;
    if (!privateMember(parent) || parent.property !== reference) fail('private method is extracted or aliased');
    const call = context.parents.get(parent);
    if (call?.type !== 'CallExpression' || call.callee !== parent || call.optional) fail('private method is not directly invoked');
    calls.push(call);
  }
  if (!calls.length) fail('private method has no invocation witness');
  return calls;
}

// Resolve only the identity of a computed-read alias. The values of parameters,
// properties and type annotations supply no nonactivation authority here.
function eventAliasBindings(context) {
  const scopeTypes = new Set(['Program', 'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'BlockStatement', 'StaticBlock', 'CatchClause', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'SwitchStatement', 'ClassDeclaration', 'ClassExpression']);
  const scopes = new Map(); let remaining = 2_000_000;
  const step = () => { if (--remaining < 0) fail('computed alias binding work bound exceeded: ' + context.path); };
  const parent = node => {
    const owner = context.parents.get(node);
    // The switch discriminant executes outside the case-block lexical scope.
    return owner?.type === 'SwitchStatement' && owner.discriminant === node ? context.parents.get(owner) : owner;
  };
  const scope = node => {
    const pending = []; let at = node;
    while (at && !scopes.has(at)) { step(); pending.push(at); at = parent(at); }
    let value = at ? scopes.get(at) : null;
    while (pending.length) {
      const item = pending.pop(), owner = context.parents.get(item);
      if (scopeTypes.has(item.type)) value = { node: item, parent: value, names: new Map(), variable: item.type === 'Program' || item.type === 'StaticBlock' || item.type === 'BlockStatement' && functionNode(owner) && owner.body === item };
      scopes.set(item, value);
    }
    return value;
  };
  const identifiers = pattern => {
    const found = [], pending = [pattern];
    while (pending.length) {
      step(); const node = unwrap(pending.pop()); if (!node) continue;
      if (node.type === 'Identifier') found.push(node);
      else if (node.type === 'ObjectPattern') for (const property of node.properties) {
        if (property.type === 'RestElement') pending.push(property.argument);
        else if (property.type === 'Property') pending.push(property.value);
        else fail('computed alias binding pattern is unresolved: ' + context.path);
      }
      else if (node.type === 'ArrayPattern') pending.push(...node.elements);
      else if (node.type === 'AssignmentPattern') pending.push(node.left);
      else if (node.type === 'RestElement') pending.push(node.argument);
      else if (node.type === 'TSParameterProperty') pending.push(node.parameter);
      else fail('computed alias binding pattern is unresolved: ' + context.path);
    }
    return found;
  };
  const variableScope = value => { while (value && !value.variable) { step(); value = value.parent; } return value; };
  const bind = (value, pattern, kind) => {
    for (const name of identifiers(pattern)) {
      step(); if (!value) fail('computed alias declaration has no lexical scope: ' + context.path);
      let binding = value.names.get(name.name);
      if (binding && !(value.variable && [kind, ...binding.kinds].every(item => ['var', 'function'].includes(item)))) fail('computed alias binding is ambiguous: ' + context.path);
      if (!binding) { binding = { kinds: new Set() }; value.names.set(name.name, binding); }
      binding.kinds.add(kind);
    }
  };
  for (const node of context.nodes) {
    step();
    if (node.type === 'VariableDeclarator') {
      const declaration = context.parents.get(node);
      if (declaration?.type !== 'VariableDeclaration') fail('computed alias declaration kind is unresolved: ' + context.path);
      bind(declaration.kind === 'var' ? variableScope(scope(node)) : scope(node), node.id, declaration.kind);
    } else if (node.type === 'FunctionDeclaration') bind(scope(context.parents.get(node)), node.id, 'function');
    else if (node.type === 'FunctionExpression' && node.id) bind(scope(node), node.id, 'function-name');
    else if (node.type === 'ClassDeclaration') bind(scope(context.parents.get(node)), node.id, 'class');
    else if (node.type === 'ClassExpression' && node.id) bind(scope(node), node.id, 'class-name');
    else if (['ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(node.type)) bind(scope(node), node.local, 'import');
    else if (node.type === 'CatchClause') bind(scope(node), node.param, 'catch');
    // Parameter initializers cannot see declarations hoisted into the body.
    if (functionNode(node)) for (const parameter of node.params) bind(scope(node), parameter, 'parameter');
  }
  return node => {
    node = unwrap(node); if (node?.type !== 'Identifier') fail('computed alias reference is unresolved: ' + context.path);
    for (let value = scope(node); value; value = value.parent) { step(); if (value.names.has(node.name)) return value.names.get(node.name); }
    fail('computed alias reference has no binding: ' + context.path);
  };
}

// This describes candidate syntax only. A method name does not establish a
// primitive receiver; the full reviewed application effect must discharge it.
function conditionalEventDataCall(context, node, declaration, calls) {
  if (!declaration || context.parents.get(declaration)?.kind !== 'const' || !calls.length || calls.length > 4096) return null;
  if (calls.some(call => call.type !== 'CallExpression' || call.optional || call.callee?.type !== 'MemberExpression' || call.callee.computed || call.callee.optional || member(call.callee) !== 'endsWith' || call.arguments.length !== 1 || literal(call.arguments[0]) === null)) return null;
  const hash = text => 'sha256:' + createHash('sha256').update(text).digest('hex');
  const identity = item => ({ ...span(item), expressionSha256: hash(context.text.slice(item.start, item.end)) });
  return { source: context.path, ...identity(node), sourceSha256: hash(context.text),
    declaration: identity(declaration), calls: calls.map(call => ({ ...identity(call), method: 'endsWith', argument: literal(call.arguments[0]) })).sort((a,b) => a.start-b.start || a.end-b.end),
    requirement: 'reviewed-primitive-string-method' };
}

function assertEventDataEffects(conditional, applicationSourceProfile) {
  if (!conditional.length && applicationSourceProfile === undefined) return;
  const reviewed = applicationSourceProfile?.eventDataEffects;
  if (applicationSourceProfile?.kind !== 'verified-d11-application-profile-1' || applicationSourceProfile.profile !== 'reviewed-d11-startup-corpus-1' || !Array.isArray(applicationSourceProfile.inputs) ||
      reviewed?.kind !== 'reviewed-d11-event-data-calls-1' || !isDeepStrictEqual(Object.keys(reviewed).sort(), ['kind','sites']) || !Array.isArray(reviewed.sites) || reviewed.sites.length > 4096) fail('computed data-call effects lack the reviewed corpus contract');
  const sites = conditional.map(row => {
    const inputs = applicationSourceProfile.inputs.filter(input => input.path === row.source);
    if (inputs.length !== 1 || inputs[0].sha256 !== row.sourceSha256) fail('computed data-call source is not reviewed');
    const { requirement, ...identity } = row;
    if (requirement !== 'reviewed-primitive-string-method') fail('computed data-call obligation differs');
    return { ...identity, effect: 'request-operation-literal-string-method' };
  });
  const ordered = rows => [...rows].sort((a,b) => a.source.localeCompare(b.source) || a.start-b.start || a.end-b.end);
  if (!isDeepStrictEqual(ordered(sites), ordered(reviewed.sites))) fail('computed data-call effects differ from the reviewed complete inventory');
}

// This is a source census, not a claim that unknown application code or arbitrary
// injected code cannot synthesize events. The fixed workload starts with a fresh
// document and the retained, sealed script corpus. Unknown activation in that
// corpus prevents this particular proof; it is never silently treated as inert.
function inspectD11EventCorpus({ sourceTextByPath, parser, requiredAbsentGlobals = [], corpus: supplied } = {}) {
  const conditionalEventDataEffects = [];
  const corpus = supplied ?? parseCorpus(sourceTextByPath, parser);
  const activation = new Set(['click', 'dblclick', 'keydown', 'keyup', 'keypress', 'pointerdown', 'pointerup', 'mousedown', 'mouseup']);
  for (const context of corpus.values()) {
    let resolveAlias;
    for (const node of context.nodes) {
    if (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression') {
      let target = node.left ?? node.argument; while (target?.type === 'MemberExpression') target = target.object;
      if (target?.type === 'Identifier' && ['Object','Array','Reflect'].includes(target.name)) fail('native inspection operation is overwritten: ' + context.path);
    }
    if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression' && node.callee.object?.name === 'Object' && ['defineProperty','defineProperties','assign'].includes(member(node.callee)) && ['Object','Array','Reflect'].includes(node.arguments[0]?.name)) fail('native inspection operation is replaced: ' + context.path);
    if ((node.type === 'Identifier' || node.type === 'Literal') && requiredAbsentGlobals.includes(node.name ?? node.value)) fail('optional framework hook appears in sealed application source: ' + context.path);
    if (node.type === 'Identifier' && ['eval', 'Function'].includes(node.name) && !['TSTypeReference','TSQualifiedName'].includes(context.parents.get(node)?.type)) fail('dynamic evaluation prevents callback census: ' + context.path);
    if (node.type === 'Property' && context.parents.get(node)?.type === 'ObjectPattern' && (node.computed || ['render','click','dispatchEvent','eval','Function'].includes(key(node)))) fail('callback or activation destructuring prevents the source census: ' + context.path);
    if (node.type !== 'MemberExpression') continue;
    const name = member(node), parent = context.parents.get(node);
    if (['eval','Function'].includes(name) || ['Reflect'].includes(node.object?.name) && ['get','apply','construct'].includes(name)) fail('dynamic evaluation or reflection prevents callback census: ' + context.path);
    if (name === 'prototype' && node.object?.name !== 'Object' || name === 'setPrototypeOf' || name === '__proto__') fail('prototype access can replace a reviewed callback consumer: ' + context.path);
    if (['render','click','dispatchEvent','handleEvent'].includes(name) && (parent?.type === 'AssignmentExpression' && parent.left === node || parent?.type === 'UpdateExpression' || parent?.type === 'UnaryExpression' && parent.operator === 'delete')) fail('callback consumer is overwritten: ' + context.path);
    if (node.computed && name === null) {
      // Computed data reads remain data. A type annotation is erased and cannot
      // establish the runtime key of a computed invocation or callable alias.
      const immediateCall = ['CallExpression','NewExpression'].includes(parent?.type) && parent.callee === node;
      const declaration = parent?.type === 'VariableDeclarator' && parent.init === node && parent.id?.type === 'Identifier' ? parent : null;
      const aliasCalls = declaration ? context.nodes.filter(item => {
        if (!['CallExpression','NewExpression'].includes(item.type)) return false;
        const reference = item.callee?.type === 'Identifier' ? item.callee : item.callee?.type === 'MemberExpression' && item.callee.object?.type === 'Identifier' ? item.callee.object : null;
        if (reference?.name !== declaration.id.name) return false;
        resolveAlias ??= eventAliasBindings(context);
        return resolveAlias(reference) === resolveAlias(declaration.id);
      }) : [];
      if (immediateCall) fail('computed callable has no bounded nonactivation key: ' + context.path);
      if (aliasCalls.length) {
        const obligation = conditionalEventDataCall(context, node, declaration, aliasCalls);
        if (!obligation) fail('computed callable has no bounded nonactivation key: ' + context.path);
        if (conditionalEventDataEffects.length >= 4096) fail('computed data-call obligation bound exceeded');
        conditionalEventDataEffects.push(obligation);
      }
    }
    if (['_$litType$', '_$committedValue', 'handleEvent'].includes(name)) fail('application accesses framework callback representation: ' + context.path);
    if (!['click', 'dispatchEvent'].includes(name)) continue;
    if (parent?.type !== 'CallExpression' || parent.callee !== node) fail('event activation method escapes: ' + context.path);
    if (name === 'dispatchEvent') {
      const event = unwrap(parent.arguments[0]), eventName = event?.type === 'NewExpression' && ['Event', 'CustomEvent'].includes(event.callee?.name) ? literal(event.arguments[0]) : null;
      if (!eventName || activation.has(eventName)) fail('synthetic or unknown activation can reach a feature callback: ' + context.path);
      continue;
    }
    // A fresh, unaliased download anchor cannot dispatch on a shell button.
    const identifier = node.object?.type === 'Identifier' ? node.object.name : null;
    const declarations = context.nodes.filter(item => item.type === 'VariableDeclarator' && item.id?.name === identifier);
    const declaration = declarations.length === 1 ? declarations[0] : null, creation = unwrap(declaration?.init);
    if (!identifier || creation?.type !== 'CallExpression' || member(creation.callee) !== 'createElement' || creation.callee.object?.name !== 'document' || literal(creation.arguments[0]) !== 'a') fail('programmatic click target is not a private download anchor: ' + context.path);
    for (const use of context.nodes.filter(item => item.type === 'Identifier' && item.name === identifier)) {
      const owner = context.parents.get(use);
      if (owner === declaration && owner.id === use) continue;
      if (owner?.type !== 'MemberExpression' || owner.object !== use || !['href', 'download', 'click'].includes(member(owner))) fail('download anchor escapes its bounded use: ' + context.path);
    }
    }
  }
  return { corpus, conditionalEventDataEffects };
}

// Final consumers pass only the profile freshly produced by invocation replay.
// This assertion never treats a provisional syntax obligation as discharged.
export function assertD11EventCorpus(input = {}) {
  const result = inspectD11EventCorpus(input);
  assertEventDataEffects(result.conditionalEventDataEffects, input.applicationSourceProfile);
  return result.corpus;
}

function eventBinding(context, arrow) {
  const quasi = context.parents.get(arrow), tagged = context.parents.get(quasi);
  if (arrow?.type !== 'ArrowFunctionExpression' || quasi?.type !== 'TemplateLiteral' || tagged?.type !== 'TaggedTemplateExpression' || tagged.quasi !== quasi || tagged.tag?.type !== 'Identifier' || !imported(context, tagged.tag.name, 'lit', 'html')) return null;
  const index = quasi.expressions.indexOf(arrow); if (index < 0) return null;
  let prefix = '';
  for (let at = 0; at <= index; at++) prefix += quasi.quasis[at].value.cooked + (at < index ? '${value}' : '');
  const opening = prefix.slice(prefix.lastIndexOf('<'));
  const match = /^<([a-z][a-z0-9-]*)\b[^<>]*\s@(click|keydown)=$/.exec(opening);
  if (!match || match[2] === 'click' && match[1] !== 'en-button') return null;
  if (!/^(?:\s|>)/.test(quasi.quasis[index + 1].value.cooked)) return null;
  return { template: tagged, event: match[2], element: match[1] };
}

// An application data field may also be named "render". A direct named
// validation function is a bounded noncalling consumer only if every use of
// its argument is a scalar test or native shape inspection. Types and function
// names supply no authority here; the retained function body supplies it.
function scalarArgumentConsumer(context, call, argument, corpus) {
  if (call.callee?.type !== 'Identifier') return false;
  const declaration = context.program.body.find(node => node.type === 'ImportDeclaration' && node.importKind !== 'type' && node.specifiers.some(item => item.type === 'ImportSpecifier' && item.local.name === call.callee.name));
  if (!declaration || !literal(declaration.source)?.startsWith('.')) return false;
  const specifier = declaration.specifiers.find(item => item.local.name === call.callee.name);
  const target = corpus.get(resolveSource(context.path, literal(declaration.source), corpus));
  const name = specifier.imported.name ?? literal(specifier.imported);
  const functions = target.program.body.filter(node => node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'FunctionDeclaration' && node.declaration.id?.name === name).map(node => node.declaration);
  if (functions.length !== 1) return false;
  assertStableBinding(context, call.callee.name);
  const fn = functions[0], parameter = fn.params[call.arguments.indexOf(argument)];
  if (parameter?.type !== 'Identifier') return false;
  if (target.nodes.some(node => {
    const names = node.type === 'VariableDeclarator' ? bindingNames(node.id) : ['ImportSpecifier','ImportDefaultSpecifier','ImportNamespaceSpecifier'].includes(node.type) ? bindingNames(node.local) : ['FunctionDeclaration','FunctionExpression','ClassDeclaration','ClassExpression'].includes(node.type) ? bindingNames(node.id) : [];
    if (functionNode(node)) names.push(...node.params.flatMap(bindingNames));
    return names.some(name => ['Object','Array'].includes(name));
  })) return false;
  for (const use of target.nodes.filter(node => node.type === 'Identifier' && node.name === parameter.name && contains(fn, node, target.parents) && node !== parameter)) {
    const parent = target.parents.get(use);
    if (parent?.type === 'UnaryExpression' && ['typeof','!'].includes(parent.operator) || parent?.type === 'LogicalExpression' && parent.operator === '&&' && parent.left === use || parent?.type === 'BinaryExpression') continue;
    if (parent?.type === 'CallExpression' && parent.arguments.includes(use) && parent.callee?.type === 'MemberExpression' && !parent.callee.computed && (
      parent.callee.object?.name === 'Object' && ['keys','hasOwn'].includes(member(parent.callee)) || parent.callee.object?.name === 'Array' && member(parent.callee) === 'isArray')) continue;
    return false;
  }
  return true;
}

function proveTemplateConsumer(context, template, klass, corpus) {
  let value = template;
  for (;;) {
    const parent = context.parents.get(value);
    if (parent?.type === 'ReturnStatement' && parent.argument === value) {
      const owner = methodOwner(context, parent);
      const nearestFunction = ancestor(parent, context.parents, functionNode);
      if (owner && nearestFunction === owner.value && key(owner) === 'render' && contains(klass, owner, context.parents)) break;
      // A repeat item renderer returns a TemplateResult, never calls its event
      // functions. Its exact imported directive is separately contract-bound.
      const arrow = ancestor(parent, context.parents, functionNode);
      const call = arrow && context.parents.get(arrow);
      if (arrow?.type !== 'ArrowFunctionExpression' || call?.type !== 'CallExpression' || call.arguments.at(-1) !== arrow || call.callee?.type !== 'Identifier' || !imported(context, call.callee.name, 'lit/directives/repeat.js', 'repeat')) fail('template return escapes a reviewed render consumer');
      value = call; continue;
    }
    if (parent?.type === 'TemplateLiteral' && parent.expressions.includes(value)) {
      const tagged = context.parents.get(parent);
      if (tagged?.type !== 'TaggedTemplateExpression' || !imported(context, tagged.tag?.name, 'lit', 'html')) fail('template is forwarded to an unknown tag');
      value = tagged; continue;
    }
    fail('template result is extracted, stored, or passed to an unknown consumer');
  }
  // A zero-argument render() result must flow into a Lit template or be ignored.
  // This catches direct .values extraction, destructuring, callback-array reads,
  // and passing a returned template to an unproved helper before readiness.
  for (const source of corpus.values()) for (const node of source.nodes) {
    if (node.type === 'MemberExpression' && member(node) === 'render') {
      const parent = source.parents.get(node);
      if (parent?.type === 'MemberExpression' && ['bind','call','apply'].includes(member(parent))) fail('render method escapes through indirect invocation: ' + source.path);
      if (parent?.type === 'CallExpression' && parent.arguments.includes(node)) fail('render method is passed to an unknown consumer: ' + source.path);
      if (parent?.type === 'VariableDeclarator' && parent.init === node && parent.id?.type === 'Identifier') {
        const name = parent.id.name;
        const owner = ancestor(parent, source.parents, functionNode) ?? source.program;
        const names = new Set([name]); let changed = true;
        while (changed) { changed = false; for (const item of source.nodes) if (item.type === 'VariableDeclarator' && item.id?.type === 'Identifier' && item.init?.type === 'Identifier' && names.has(item.init.name) && contains(owner,item,source.parents) && !names.has(item.id.name)) { names.add(item.id.name); changed = true; } }
        for (const item of source.nodes.filter(item => item.type === 'Identifier' && names.has(item.name) && contains(owner,item,source.parents))) {
          const use = source.parents.get(item);
          if (use?.type === 'CallExpression' && use.callee === item || use?.type === 'MemberExpression' && use.object === item && ['bind','call','apply'].includes(member(use))) fail('render method is extracted as a callable: ' + source.path);
          if (use?.type === 'CallExpression' && use.arguments.includes(item) && !scalarArgumentConsumer(source,use,item,corpus)) fail('render alias reaches an unknown caller: ' + source.path);
          if (use?.type === 'ReturnStatement' || use?.type === 'Property' && use.value === item || use?.type === 'ArrayExpression') fail('render alias escapes in an aggregate: ' + source.path);
        }
      }
    }
    if (node.type !== 'CallExpression' || member(node.callee) !== 'render') continue;
    if (node.arguments.length) {
      // Extra arguments do not change JavaScript's callable identity. Unknown
      // receivers cannot use arity to evade the zero-argument render census.
      let receiver = unwrap(node.callee.object);
      while (receiver?.type === 'MemberExpression') receiver = unwrap(receiver.object);
      const owner = ancestor(node, source.parents, item => item.type === 'ClassDeclaration');
      if (receiver?.type !== 'ThisExpression' || !owner || owner === klass) fail('render with arguments has an unproved target receiver: ' + source.path);
      continue;
    }
    let value = node, parent = source.parents.get(value);
    while (parent && ['ChainExpression', 'TSNonNullExpression', 'TSAsExpression', 'ConditionalExpression', 'LogicalExpression'].includes(parent.type)) { value = parent; parent = source.parents.get(value); }
    if (parent?.type === 'AwaitExpression') { value = parent; parent = source.parents.get(value); }
    if (parent?.type === 'ExpressionStatement') continue;
    if (parent?.type !== 'TemplateLiteral' || !parent.expressions.includes(value)) fail('render result has an unproved callback consumer: ' + source.path);
    const tag = source.parents.get(parent);
    if (tag?.type !== 'TaggedTemplateExpression' || !imported(source, tag.tag?.name, 'lit', 'html')) fail('render result reaches an unreviewed template tag');
  }
}

function eventRoot(context, klass, node, corpus, active = new Set()) {
  for (let at = node; at; at = context.parents.get(at)) {
    if (at.type === 'ArrowFunctionExpression') {
      const binding = eventBinding(context, at);
      if (binding) { proveTemplateConsumer(context, binding.template, klass, corpus); return [binding.event]; }
    }
    if (at.type === 'MethodDefinition') {
      if (at.key?.type !== 'PrivateIdentifier' || active.has(at)) fail('callback is reachable through an unproved public or recursive method');
      const next = new Set(active); next.add(at);
      return sorted(privateCalls(context, klass, at.key.name).flatMap(call => eventRoot(context, klass, call, corpus, next)));
    }
  }
  fail('callback has no sealed event root');
}

function commandBoundary(context, klass, arrow, corpus) {
  const property = context.parents.get(arrow), row = context.parents.get(property), array = context.parents.get(row), returned = context.parents.get(array);
  if (property?.type !== 'Property' || property.value !== arrow || property.kind !== 'init' || property.computed || row?.type !== 'ObjectExpression' || array?.type !== 'ArrayExpression' || returned?.type !== 'ReturnStatement' || returned.argument !== array) fail('private caller is not a literal command-table callback');
  const capability = key(property), producer = methodOwner(context, arrow);
  if (!capability || producer?.key?.type !== 'PrivateIdentifier') fail('command table producer is not runtime-private');
  for (const item of array.elements) if (item?.type !== 'ObjectExpression' || item.properties.some(field => field.type !== 'Property' || field.kind !== 'init' || field.computed)) fail('command table contains unknown getters or spreads');
  const invoke = one(privateCalls(context, klass, producer.key.name), 'command table producer has multiple consumers');
  const provider = context.parents.get(invoke), creation = context.parents.get(provider);
  if (provider?.type !== 'ArrowFunctionExpression' || provider.body !== invoke || provider.params.length || creation?.type !== 'NewExpression' || creation.callee?.type !== 'Identifier') fail('command table producer escapes its constructor callback');
  const slot = creation.arguments.indexOf(provider), consumer = importOwner(context, creation.callee.name, corpus), target = consumer.context;
  const constructor = one(consumer.klass.body.body.filter(node => node.type === 'MethodDefinition' && node.kind === 'constructor'), 'command consumer lacks one constructor');
  const parameter = constructor.value.params[slot];
  if (parameter?.type !== 'Identifier') fail('command callback parameter has an unsupported binding');
  const assignments = target.nodes.filter(node => node.type === 'AssignmentExpression' && privateMember(node.left) && node.right?.type === 'Identifier' && node.right.name === parameter.name && contains(constructor, node, target.parents));
  const assignment = one(assignments, 'command callback is not stored once in a private field'), stored = assignment.left.property.name;
  for (const use of target.nodes.filter(node => node.type === 'Identifier' && node.name === parameter.name && contains(constructor, node, target.parents))) if (use !== parameter && use !== assignment.right) fail('command callback parameter escapes construction');
  const reads = target.nodes.filter(node => node.type === 'PrivateIdentifier' && node.name === stored && contains(consumer.klass, node, target.parents));
  const gets = [];
  for (const read of reads) {
    const owner = target.parents.get(read);
    if (owner?.type === 'PropertyDefinition' && owner.key === read) continue;
    if (owner === assignment.left) continue;
    const call = target.parents.get(owner);
    if (!privateMember(owner) || call?.type !== 'CallExpression' || call.callee !== owner || call.arguments.length) fail('private command callback escapes storage');
    gets.push(call);
  }
  const get = one(gets, 'private command callback has multiple readers'), items = methodOwner(target, get);
  if (items?.key?.type !== 'PrivateIdentifier') fail('command array reader is not private');
  const declaration = target.parents.get(get);
  if (declaration?.type !== 'VariableDeclarator' || declaration.id?.type !== 'Identifier') fail('command array has no bounded local owner');
  const arrayName = declaration.id.name;
  const scalarFields = new Set(array.elements.flatMap(item => item.properties.map(key)).filter(name => name !== capability));
  const scalarRow = (root, parameter) => {
    if (parameter?.type !== 'Identifier') fail('command inventory destructures or aliases a row');
    for (const use of target.nodes.filter(node => node.type === 'Identifier' && node.name === parameter.name && contains(root, node, target.parents) && node !== parameter)) {
      const parent = target.parents.get(use);
      if (parent?.type !== 'MemberExpression' || parent.object !== use || parent.computed || !scalarFields.has(member(parent))) fail('command inventory row escapes scalar validation');
      const next = target.parents.get(parent);
      if (next?.type === 'CallExpression' && next.callee === parent || next?.type === 'AssignmentExpression' && next.left === parent || next?.type === 'UpdateExpression') fail('command inventory invokes or mutates a row');
    }
  };
  for (const node of target.nodes.filter(node => contains(items, node, target.parents))) {
    if (node.type === 'MemberExpression' && (node.computed || member(node) === capability)) fail('command inventory reads an executable row property');
    if (node.type !== 'Identifier' || node.name !== arrayName || node === declaration.id) continue;
    const parent = target.parents.get(node);
    if (parent?.type === 'MemberExpression' && parent.object === node && member(parent) === 'length') continue;
    if (parent?.type === 'MemberExpression' && parent.object === node && member(parent) === 'filter') {
      const call = target.parents.get(parent), predicate = call?.arguments?.[0];
      if (call?.type !== 'CallExpression' || call.callee !== parent || call.arguments.length !== 1 || predicate?.type !== 'ArrowFunctionExpression' || predicate.params.length !== 1) fail('command filter has an unknown callback');
      scalarRow(predicate, predicate.params[0]); continue;
    }
    if (parent?.type === 'ForOfStatement' && parent.right === node) {
      const binding = parent.left;
      if (binding?.type !== 'VariableDeclaration' || binding.kind !== 'const' || binding.declarations.length !== 1) fail('command row loop does not own a const binding');
      scalarRow(parent, binding.declarations[0].id); continue;
    }
    if (parent?.type === 'ConditionalExpression' && parent.alternate === node || parent?.type === 'ReturnStatement') continue;
    fail('command array escapes its inventory method');
  }
  const events = new Set();
  for (const call of privateCalls(target, consumer.klass, items.key.name)) {
    const owner = methodOwner(target, call);
    if (owner?.key?.type === 'PrivateIdentifier') { for (const event of eventRoot(target, consumer.klass, call, corpus)) events.add(event); continue; }
    if (key(owner) !== 'render') fail('command array reaches an unproved public consumer');
    const select = target.parents.get(call), map = target.parents.get(select);
    if (select?.type !== 'MemberExpression' || select.object !== call || member(select) !== 'map' || map?.type !== 'CallExpression' || map.callee !== select || map.arguments.length !== 1) fail('render exposes the command array instead of copying display fields');
    const copy = map.arguments[0], pattern = copy?.params?.[0];
    if (copy?.type !== 'ArrowFunctionExpression' || copy.params.length !== 1 || pattern?.type !== 'ObjectPattern' || pattern.properties.some(item => item.type !== 'Property' || item.computed || key(item) === capability || item.value?.type !== 'Identifier')) fail('render copies an executable command field');
    const output = unwrap(copy.body), names = new Set(pattern.properties.map(item => item.value.name));
    if (output?.type !== 'ObjectExpression' || output.properties.some(item => item.type !== 'Property' || item.computed || item.value?.type !== 'Identifier' || !names.has(item.value.name))) fail('display row copy has an unknown callback escape');
  }
  if (!events.has('click') || !events.has('keydown')) fail('command execution lacks both reviewed event paths');
  return { events: sorted(events), consumer: target.path, producer: producer.key.name, callbackField: stored, itemsMethod: items.key.name, capability };
}

/** Structural source proof only. It supplies no dependency authority and must
 * not itself be consumed as a roles exemption. Exported for focused specimens;
 * deriveD11PrivateEventBoundaries verifies the retained dependency contract. */
export function deriveD11PrivateEventSourceProof({ manifest, files, sourceTextByPath, outputTextByFile, parser, roleContext, requiredAbsentGlobals = [] } = {}) {
  const excludedImports = [], missing = []; let conditionalEventDataEffects = [];
  try {
    const corpus = parseCorpus(sourceTextByPath, parser), candidates = [];
    for (const context of corpus.values()) for (const node of context.nodes) if (node.type === 'ImportExpression') {
      const method = methodOwner(context, node), klass = method && ancestor(method, context.parents, item => item.type === 'ClassDeclaration');
      if (method?.key?.type === 'PrivateIdentifier' && klass) candidates.push({ context, node, method, klass });
    }
    if (!candidates.length) return { excludedImports, complete: true, missing };
    if (!isDeepStrictEqual(roleContext, D11_ROLE_CONTEXT)) fail('fixed W0/W1 Open context is absent');
    ({ conditionalEventDataEffects } = inspectD11EventCorpus({ corpus, requiredAbsentGlobals }));
    for (const { context, node, method, klass } of candidates) {
      if (klass.superClass?.type !== 'Identifier' || !imported(context, klass.superClass.name, 'lit', 'LitElement')) fail('private event owner is not the reviewed LitElement subclass');
      assertStableBinding(context, klass.id?.name);
      const calls = privateCalls(context, klass, method.key.name);
      if (calls.length !== 2) fail('private load boundary must have exactly two accounted callers');
      const witnesses = [];
      for (const call of calls) {
        const arrow = context.parents.get(call);
        if (arrow?.type !== 'ArrowFunctionExpression' || arrow.body !== call || arrow.params.length || call.arguments.length) fail('private feature caller is not a plain zero-argument arrow');
        const event = eventBinding(context, arrow);
        if (event) { proveTemplateConsumer(context, event.template, klass, corpus); witnesses.push({ source: context.path, ...span(call), kind: 'lit-event', events: [event.event] }); }
        else { const command = commandBoundary(context, klass, arrow, corpus); witnesses.push({ source: context.path, ...span(call), kind: 'private-command-event', events: command.events, command }); }
      }
      if (witnesses.filter(item => item.kind === 'lit-event').length !== 1 || witnesses.filter(item => item.kind === 'private-command-event').length !== 1) fail('private callers do not close both independent event paths');
      const featureSource = resolveSource(context.path, literal(node.source), corpus);
      const targets = sorted(Object.values(manifest ?? {}).filter(entry => entry?.src === featureSource && entry.isDynamicEntry === true).map(entry => entry.file));
      const target = one(targets, 'private feature has no unique dynamic manifest entry');
      const outputs = sorted((files ?? []).filter(file => file.kind === 'js' && [...file.sources ?? [], ...file.modules ?? []].includes(context.path)).map(file => file.file));
      if (!outputs.length || !(files ?? []).some(file => file.file === target && file.kind === 'js' && [...file.sources ?? [], ...file.modules ?? []].includes(featureSource))) fail('private import source/output mapping is incomplete');
      for (const other of corpus.values()) for (const reference of other.nodes.filter(item => item.type === 'ImportExpression')) {
        const specifier = literal(reference.source);
        if (specifier?.startsWith('.') && resolveSource(other.path, specifier, corpus) === featureSource && reference !== node) fail('private target has another source import site');
      }
      const emitted = [];
      for (const file of files ?? []) {
        if (file.kind !== 'js') continue;
        const text = outputTextByFile?.[file.file]; if (typeof text !== 'string') fail('emitted JS text is absent');
        const result = parser.parseSync(file.file, text, { lang: 'js', sourceType: 'module' });
        if (result.errors?.length || result.program?.type !== 'Program') fail('emitted JS cannot be parsed');
        for (const reference of tree(result.program).nodes.filter(item => item.type === 'ImportExpression')) {
          const specifier = literal(reference.source);
          if (!specifier) fail('computed emitted import prevents target census');
          const resolved = posix.normalize(specifier.startsWith('/') ? specifier.slice(1) : posix.join(posix.dirname(file.file), specifier));
          if (resolved === target) emitted.push({ output: file.file, ...span(reference) });
        }
      }
      if (emitted.length !== 1 || !outputs.includes(emitted[0].output)) fail('private target has no unique emitted import-site binding');
      excludedImports.push({ source: context.path, ...span(node), target, outputs, reason: 'verified-private-event-boundary', witness: { kind: 'd11-private-event-import-1', offsetUnits: 'utf16-code-unit', featureSource, className: klass.id.name, privateMethod: method.key.name, calls: witnesses.sort((a, b) => a.start - b.start), emitted } });
    }
  } catch (error) { missing.push(error instanceof Error ? error.message : 'D11 private event proof is unavailable'); }
  return { excludedImports: missing.length ? [] : excludedImports, complete: missing.length === 0, missing, ...(conditionalEventDataEffects.length ? { conditionalEventDataEffects } : {}) };
}

export function deriveD11PrivateEventBoundaries(input = {}) {
  const structural = deriveD11PrivateEventSourceProof(input);
  if (!structural.complete || !structural.excludedImports.length) return structural;
  try {
    if (!input.invocationContract) fail('retained invocation contract is absent for a private target');
    const verified = verifyD11InvocationContract(input.invocationContract, { lock: input.lock, dependencyInputs: input.dependencyInputs, emittedModules: sorted((input.files ?? []).flatMap(file => file.modules ?? [])), compilation: input.compilation, sourceTextByPath: input.sourceTextByPath, sourceInputs: input.sourceInputs, outputTextByFile: input.outputTextByFile });
    if (verified.effects?.repeatRender !== 'eager-key-and-item-render-with-child-part-commit' || verified.effects?.supportedCompilation !== 'reviewed-vite-app-config-and-build-evidence' || verified.effects?.applicationSourceProfile !== 'reviewed-d11-startup-corpus-1') fail('reviewed template, compilation, or application source effects are absent');
    assertD11EventCorpus({ sourceTextByPath: input.sourceTextByPath, parser: input.parser, requiredAbsentGlobals: verified.requiredAbsentGlobals, applicationSourceProfile: verified.applicationSourceProfile });
    return { ...structural, excludedImports: structural.excludedImports.map(item => ({ ...item, witness: { ...item.witness, invocationProfile: verified.profile, applicationSourceProfile: verified.effects.applicationSourceProfile, eventDataEffects: verified.applicationSourceProfile.eventDataEffects } })) };
  } catch (error) { return { excludedImports: [], complete: false, missing: [error instanceof Error ? error.message : 'D11 private dependency contract is unavailable'] }; }
}
