const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setup(options = {}) {
  const calls = [];
  const doc = {id: '2-42', idReadable: 'TEST-42', summary: 'Example', description: 'Hello 🌍\nsecond line',
    content: 'Hello 🌍\nsecond line', updated: 100, created: 10, project: {id: '0-1', shortName: 'TEST'},
    customFields: [], tags: [], parentArticle: null};
  Object.assign(doc, options.document);
  class Connection {
    constructor(url) { assert.equal(url, 'https://tracker.example'); }
    bearerAuth(secret) { assert.equal(secret, 'SECRET'); }
    addHeader() {}
    getSync(uri, params) {
      for (const value of Object.values(params)) assert.equal(typeof value, 'string', 'YouTrack HTTP query values must be strings');
      calls.push({uri, params});
      let data;
      if (uri === '/api/users/me') data = {login: options.tokenLogin || 'alice'};
      else if (options.response) return options.response(uri, params, doc);
      else if (uri.endsWith('/comments')) data = options.items || [];
      else if (uri.endsWith('/activities')) data = options.items || [];
      else if (uri === '/api/issues' || uri === '/api/articles') data = options.items || [doc];
      else data = doc;
      return {code: 200, response: JSON.stringify(data)};
    }
  }
  const ctx = {currentUser: {login: options.caller || 'alice'}, settings: {
    youtrackUrl: 'https://tracker.example', restToken: 'SECRET', exporterLogin: 'alice', projectKeys: 'TEST'
  }, arguments: {kind: 'issue', project: 'TEST', id: 'TEST-42', ...options.arguments}};
  Object.assign(ctx.settings, options.settings);
  const module = {exports: {}};
  const code = fs.readFileSync(path.join(__dirname, '../app/lib.js'), 'utf8');
  vm.runInNewContext('(function(require, exports) {' + code + '\n})', {})(name => {
    assert.equal(name, '@jetbrains/youtrack-scripting-api/http');
    return {Connection};
  }, module.exports);
  return {api: module.exports, ctx, calls, doc};
}

test('authorized caller can read a document with stable identity and source URL', () => {
  const {api, ctx, calls} = setup();
  const result = api.getDocument(ctx);
  assert.equal(result.id, 'youtrack:https://tracker.example:issue:2-42');
  assert.equal(result.url, 'https://tracker.example/issue/TEST-42');
  assert.equal(result.content, 'Hello 🌍\nsecond line');
  assert.equal(result.nextContentOffset, null);
  assert.equal(result.complete, true);
  assert.equal(calls[0].uri, '/api/users/me');
});

test('foreign caller is rejected before any REST call', () => {
  const {api, ctx, calls} = setup({caller: 'bob'});
  assert.throws(() => api.getDocument(ctx), /CALLER_NOT_ALLOWED/);
  assert.equal(calls.length, 0);
});

test('token owner must match the MCP caller', () => {
  const {api, ctx, calls} = setup({tokenLogin: 'admin'});
  assert.throws(() => api.getDocument(ctx), /TOKEN_IDENTITY_MISMATCH/);
  assert.equal(calls.length, 1);
});

test('documents outside configured projects are rejected', () => {
  const {api, ctx} = setup({document: {project: {shortName: 'PRIVATE'}}});
  assert.throws(() => api.getDocument(ctx), /PROJECT_NOT_ALLOWED/);
});

test('REST failure cannot become an empty successful page', () => {
  const {api, ctx} = setup({response: () => ({code: 403, response: 'SECRET private data'})});
  assert.throws(() => api.listDocuments(ctx), e => /REST_HTTP_403/.test(e.message) && !e.message.includes('SECRET'));
});

test('malformed REST payload is an explicit failure', () => {
  const {api, ctx} = setup({response: () => ({code: 200, response: '{'})});
  assert.throws(() => api.listDocuments(ctx), /REST_INVALID_JSON/);
});

test('invalid list shape is rejected', () => {
  const {api, ctx} = setup({response: () => ({code: 200, response: '{}'})});
  assert.throws(() => api.listDocuments(ctx), /REST_INVALID_SHAPE/);
});

test('list pagination uses lookahead and exposes non-atomic enumeration', () => {
  const a = {id: '2-1', idReadable: 'TEST-1', summary: 'One', updated: 1, project: {shortName: 'TEST'}};
  const b = {...a, id: '2-2', idReadable: 'TEST-2'};
  const {api, ctx, calls} = setup({items: [a, b], arguments: {limit: 1}});
  const result = api.listDocuments(ctx);
  assert.equal(result.items.length, 1);
  assert.equal(result.nextOffset, 1);
  assert.equal(result.complete, false);
  assert.equal(result.consistency, 'non_atomic');
  assert.equal(calls[1].params.$top, '2');
});

test('empty authorized list is a valid complete page', () => {
  const {api, ctx} = setup({items: []});
  const result = api.listDocuments(ctx);
  assert.equal(result.items.length, 0);
  assert.equal(result.nextOffset, null);
  assert.equal(result.complete, true);
});

test('article enumeration uses project collection and preserves offsets', () => {
  const {api, ctx, calls} = setup({arguments: {kind: 'article', limit: 1}, response: (uri, params, doc) => {
    const docs = [doc, {...doc, id: '2-43', idReadable: 'TEST-A-43'}];
    return {code: 200, response: JSON.stringify(docs.slice(Number(params.$skip), Number(params.$skip) + Number(params.$top)))};
  }});
  const first = api.listDocuments(ctx);
  assert.equal(calls[1].uri, '/api/admin/projects/TEST/articles');
  assert.equal(calls[1].params.query, undefined);
  assert.equal(first.nextOffset, 1);
  ctx.arguments.offset = first.nextOffset;
  const second = api.listDocuments(ctx);
  assert.equal(second.items[0].sourceId, '2-43');
  assert.notEqual(first.items[0].sourceId, second.items[0].sourceId);
  assert.equal(second.nextOffset, null);
  assert.equal(calls.at(-1).params.$skip, '1');
});

test('article search queries are rejected instead of silently ignored', () => {
  const {api, ctx} = setup({arguments: {kind: 'article', query: 'some search'}});
  assert.throws(() => api.listDocuments(ctx), /ARTICLE_QUERY_NOT_SUPPORTED/);
});

test('text pages reconstruct Unicode content without truncation', () => {
  const {api, ctx, doc} = setup({arguments: {contentLimit: 7}});
  let content = '';
  for (let i = 0; i < 20; i++) {
    const page = api.getDocument(ctx);
    assert.ok(!/[\uD800-\uDBFF]$/.test(page.content));
    content += page.content;
    if (page.complete) break;
    ctx.arguments.contentOffset = page.nextContentOffset;
    ctx.arguments.expectedUpdatedAt = page.updatedAt;
  }
  assert.equal(content, doc.description);
});

test('continuation requires a revision and rejects changed documents', () => {
  const {api, ctx} = setup({arguments: {contentOffset: 2}});
  assert.throws(() => api.getDocument(ctx), /REVISION_REQUIRED/);
  ctx.arguments.expectedUpdatedAt = 99;
  assert.throws(() => api.getDocument(ctx), /DOCUMENT_CHANGED/);
});

test('comments are paginated independently and checked against parent project', () => {
  const {api, ctx, calls} = setup({items: [{id: '4-1', text: 'first'}, {id: '4-2', text: 'second'}], arguments: {limit: 1}});
  const result = api.getComments(ctx);
  assert.equal(result.items[0].text, 'first');
  assert.equal(result.nextOffset, 1);
  assert.ok(calls.some(c => c.uri === '/api/issues/TEST-42'));
});

test('history continuation requires a fixed upper time bound', () => {
  const {api, ctx} = setup({arguments: {offset: 1}});
  assert.throws(() => api.getIssueHistory(ctx), /HISTORY_END_REQUIRED/);
});

test('history returns old and new values with explicit paging', () => {
  const items = [{id: 'e1', timestamp: 10, field: {name: 'State'}, added: [{name: 'Done'}], removed: [{name: 'Open'}]}];
  const {api, ctx, calls} = setup({items, arguments: {end: 1000}});
  const result = api.getIssueHistory(ctx);
  assert.equal(result.items[0].added[0].name, 'Done');
  assert.equal(result.end, 1000);
  assert.equal(result.nextOffset, null);
  assert.equal(calls.at(-1).params.end, '1000');
});

test('unsafe IDs, project names and endpoints are rejected', () => {
  for (const args of [{id: '../users'}, {kind: 'users'}, {id: 'TEST-1?fields=secret'}]) {
    const {api, ctx} = setup({arguments: args});
    assert.throws(() => api.getDocument(ctx), /INVALID_/);
  }
  const {api, ctx} = setup({settings: {youtrackUrl: 'http://evil.example'}});
  assert.throws(() => api.getDocument(ctx), /INVALID_URL/);
});

test('configured project scope cannot be escaped by search query', () => {
  const {api, ctx} = setup({arguments: {project: 'PRIVATE'}});
  assert.throws(() => api.listDocuments(ctx), /PROJECT_NOT_ALLOWED/);
});

test('packaged MCP descriptors have executable handlers and object properties', () => {
  const {api} = setup();
  for (const file of ['list-documents', 'get-document', 'get-comments', 'get-issue-history']) {
    const exported = {};
    const code = fs.readFileSync(path.join(__dirname, '../app/' + file + '.js'), 'utf8');
    vm.runInNewContext('(function(require, exports) {' + code + '\n})', {})(name => {
      assert.equal(name, './lib');
      return api;
    }, exported);
    assert.equal(typeof exported.aiTool.execute, 'function');
    assert.equal(exported.aiTool.annotations.readOnlyHint, true);
    assert.ok(exported.aiTool.outputSchema.properties);
    assert.ok(exported.aiTool.inputSchema.properties);
  }
});
