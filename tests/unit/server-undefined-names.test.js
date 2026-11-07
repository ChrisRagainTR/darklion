'use strict';

// Guards against references to variables that do not exist in scope, such as
// an uploadFile({ firmId }) call in a route that only has req.firm.id. Those
// bugs parse fine and only throw at runtime when the route is exercised.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const SERVER_DIR = process.env.UNDEFINED_NAMES_SERVER_DIR || path.join(__dirname, '..', '..', 'server');
const CANNOT_FIND_NAME = new Set([2304, 2552, 2580, 2582, 2591]);
const NODE_MODULE_NAMES = new Set(['require', 'module', 'exports', '__dirname', '__filename', 'global']);

function serverFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) serverFiles(full, found);
    else if (/\.c?js$/.test(entry.name)) found.push(path.resolve(full));
  }
  return found;
}

test('server code only references names that are defined in scope', () => {
  const files = serverFiles(SERVER_DIR);
  // noResolve keeps the check to DarkLion's own files; loading dependency type
  // definitions (for example the AWS SDK) exhausts memory on CI runners.
  const program = ts.createProgram(files, {
    allowJs: true, checkJs: true, noEmit: true, skipLibCheck: true, types: [], noResolve: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  });
  const wanted = new Set(files);
  const problems = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (!wanted.has(path.resolve(sourceFile.fileName))) continue;
    for (const diagnostic of program.getSemanticDiagnostics(sourceFile)) {
      if (!CANNOT_FIND_NAME.has(diagnostic.code)) continue;
      const name = sourceFile.text.slice(diagnostic.start, diagnostic.start + diagnostic.length);
      if (NODE_MODULE_NAMES.has(name) || name in globalThis) continue;
      const { line } = sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
      problems.push(path.relative(SERVER_DIR, sourceFile.fileName) + ':' + (line + 1) + ' ' + name);
    }
  }
  assert.deepEqual(problems, []);
});
