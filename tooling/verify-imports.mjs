import * as ts from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/sync';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const graph = JSON.parse(await readFile('node_modules/@en-reve/elements/public-api.json', 'utf8'));
const errors = [];
let checked = 0;
const api = new API({ cwd: process.cwd() });
function check(specifier, file, typeOnly = false) {
  if (!specifier.startsWith('@en-reve/')) return;
  checked++;
  if (specifier === '@en-reve/elements' && typeOnly) return;
  if (specifier === '@en-reve/elements' || specifier === '@en-reve/elements/index.js' || /\/(?:src|dist|internal|forms-private|tooling)\//.test(specifier)) {
    errors.push(`${file}: forbidden startup/private import ${specifier}`);
  } else if (specifier.startsWith('@en-reve/elements/') && !graph.entrypoints[specifier]?.supported) {
    errors.push(`${file}: unsupported public entry ${specifier}`);
  } else if (specifier.startsWith('@en-reve/primitives/') && !/^@en-reve\/primitives\/(state|interactions|templates)\/[^/]+\.js$/.test(specifier)) {
    errors.push(`${file}: unsupported primitive entry ${specifier}`);
  }
}
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { await visit(path); continue; }
    if (!/\.(?:ts|tsx|js|mjs)$/.test(path)) continue;
    const snapshot = api.updateSnapshot({ openFiles: [resolve(path)] });
    const source = snapshot.getDefaultProjectForFile(resolve(path))?.program.getSourceFile(resolve(path));
    if (!source) throw new Error(`Cannot parse consumer source: ${path}`);
    function walk(node) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        check(node.moduleSpecifier.text, path, node.importClause?.isTypeOnly);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        check(node.moduleSpecifier.text, path, node.isTypeOnly);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (!node.arguments[0] || !ts.isStringLiteral(node.arguments[0])) errors.push(`${path}: dynamic import must have a literal public target`);
        else check(node.arguments[0].text, path);
      }
      node.forEachChild(walk);
    }
    walk(source);
    snapshot.dispose();
  }
}
try {
  await visit('src');
  await visit('tests/consumer/fixture');
} finally { api.close(); }
if (errors.length) throw new Error(errors.join('\n'));
console.log(`Verified ${checked} consumer en-reve imports against packed public metadata`);
