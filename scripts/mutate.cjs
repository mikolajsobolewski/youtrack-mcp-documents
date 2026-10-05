const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
function run(cwd, name) {
  return spawnSync(process.execPath, ['--test', ...(name ? ['--test-name-pattern', '^' + name + '$'] : []), 'test/documents.test.cjs'], {cwd, encoding: 'utf8'});
}
const baseline = run(root);
assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
const mutations = [
  ['article enumeration uses project collection and preserves offsets', "'/api/admin/projects/' + encodeURIComponent(args.project) + '/articles'", "'/api/articles'"],
  ['article search queries are rejected instead of silently ignored', "if (type === 'article' && query) fail('ARTICLE_QUERY_NOT_SUPPORTED');", "if (false) fail('ARTICLE_QUERY_NOT_SUPPORTED');"],
  ['foreign caller is rejected before any REST call', "if (!login || !settings.exporterLogin || login !== settings.exporterLogin)", 'if (false)'],
  ['token owner must match the MCP caller', 'if (!identity || identity.login !== login)', 'if (false)'],
  ['documents outside configured projects are rejected', "if (typeof project !== 'string' || projects.indexOf(project) === -1)", 'if (false)'],
  ['REST failure cannot become an empty successful page', "if (!response || response.code !== 200) fail('REST_HTTP_' + (response ? response.code : 'UNAVAILABLE'));", 'if (!response || response.code !== 200) return [];'],
  ['list pagination uses lookahead and exposes non-atomic enumeration', 'const hasMore = items.length > p.limit;', 'const hasMore = false;'],
  ['continuation requires a revision and rejects changed documents', "if (args.expectedUpdatedAt !== undefined && args.expectedUpdatedAt !== d.updated) fail('DOCUMENT_CHANGED');", "if (false) fail('DOCUMENT_CHANGED');"],
  ['history continuation requires a fixed upper time bound', "if (p.offset > 0 && args.end === undefined) fail('HISTORY_END_REQUIRED');", "if (false) fail('HISTORY_END_REQUIRED');"]
];
const original = fs.readFileSync(path.join(root, 'app/lib.js'), 'utf8');
for (const [name, before, after] of mutations) {
  assert.ok(original.includes(before), 'Mutation target absent: ' + name);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-mcp-mutation-'));
  try {
    fs.cpSync(path.join(root, 'app'), path.join(dir, 'app'), {recursive: true});
    fs.cpSync(path.join(root, 'test'), path.join(dir, 'test'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'app/lib.js'), original.replace(before, after));
    const r = run(dir, name);
    assert.equal(r.status, 1, 'Mutation survived or runner failed: ' + name + '\n' + r.stdout);
    assert.ok(r.stdout.includes('ERR_ASSERTION') && r.stdout.includes('not ok') && r.stdout.includes(name), 'Expected assertion did not fail: ' + name + '\n' + r.stdout + r.stderr);
    console.log('Caught: ' + name);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}
console.log('Green baseline; caught ' + mutations.length + '/' + mutations.length + ' targeted mutations.');
