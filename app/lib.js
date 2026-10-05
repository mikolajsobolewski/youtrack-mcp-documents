'use strict';
const http = require('@jetbrains/youtrack-scripting-api/http');

function fail(code) { throw new Error(code); }
function integer(value, fallback, min, max) {
  const n = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(n) || n < min || n > max) fail('INVALID_INTEGER');
  return n;
}
function kind(value) {
  if (value !== 'issue' && value !== 'article') fail('INVALID_KIND');
  return value;
}
function entityId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*-[0-9]+$/.test(value)) fail('INVALID_ID');
  return value;
}

function client(ctx) {
  const settings = ctx.settings || {};
  const login = ctx.currentUser && ctx.currentUser.login;
  if (!login || !settings.exporterLogin || login !== settings.exporterLogin) fail('CALLER_NOT_ALLOWED');
  const base = String(settings.youtrackUrl || '').replace(/\/+$/, '');
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?(?:\/[A-Za-z0-9._~-]+)*$/.test(base)) fail('INVALID_URL');
  if (!settings.restToken) fail('TOKEN_REQUIRED');
  const projects = String(settings.projectKeys || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!projects.length || projects.some(p => !/^[A-Za-z][A-Za-z0-9_]*$/.test(p))) fail('INVALID_PROJECT_CONFIGURATION');
  const connection = new http.Connection(base, null, 15000);
  connection.bearerAuth(settings.restToken);
  connection.addHeader('Accept', 'application/json');
  function get(uri, params) {
    let response;
    const query = {};
    Object.keys(params || {}).forEach(key => { query[key] = String(params[key]); });
    try { response = connection.getSync(uri, query); }
    catch (_) { fail('REST_UNAVAILABLE'); }
    if (!response || response.code !== 200) fail('REST_HTTP_' + (response ? response.code : 'UNAVAILABLE'));
    if (typeof response.response !== 'string' || response.response.length > 2000000) fail('REST_RESPONSE_TOO_LARGE');
    try { return JSON.parse(response.response); }
    catch (_) { fail('REST_INVALID_JSON'); }
  }
  const identity = get('/api/users/me', {fields: 'login'});
  if (!identity || identity.login !== login) fail('TOKEN_IDENTITY_MISMATCH');
  function checkProject(project) {
    if (typeof project !== 'string' || projects.indexOf(project) === -1) fail('PROJECT_NOT_ALLOWED');
  }
  return {base, get, checkProject};
}

const identityFields = 'id,idReadable,summary,updated,created,project(id,shortName)';
function metadata(api, type, d) {
  if (!d || typeof d.id !== 'string' || typeof d.idReadable !== 'string' || typeof d.summary !== 'string' || !Number.isSafeInteger(d.updated)) fail('REST_INVALID_DOCUMENT');
  api.checkProject(d.project && d.project.shortName);
  return {
    schemaVersion: 1,
    id: 'youtrack:' + api.base + ':' + type + ':' + d.id,
    sourceId: d.id,
    readableId: d.idReadable,
    kind: type,
    title: d.summary,
    url: api.base + (type === 'issue' ? '/issue/' : '/articles/') + encodeURIComponent(d.idReadable),
    project: d.project.shortName,
    updatedAt: d.updated,
    createdAt: d.created === undefined ? null : d.created
  };
}
function paging(args) {
  return {offset: integer(args.offset, 0, 0, 10000000), limit: integer(args.limit, 50, 1, 100)};
}
function page(items, p) {
  if (!Array.isArray(items)) fail('REST_INVALID_SHAPE');
  const hasMore = items.length > p.limit;
  return {schemaVersion: 1, items: items.slice(0, p.limit), offset: p.offset,
    nextOffset: hasMore ? p.offset + p.limit : null, complete: !hasMore,
    consistency: 'non_atomic'};
}
function parent(api, type, id, fields) {
  const d = api.get('/api/' + type + 's/' + entityId(id), {fields: fields || identityFields});
  metadata(api, type, d);
  return d;
}

exports.listDocuments = function (ctx) {
  const api = client(ctx), args = ctx.arguments || {}, type = kind(args.kind), p = paging(args);
  api.checkProject(args.project);
  const query = args.query === undefined ? '' : args.query;
  if (typeof query !== 'string' || query.length > 1000) fail('INVALID_QUERY');
  if (type === 'article' && query) fail('ARTICLE_QUERY_NOT_SUPPORTED');
  const params = {fields: identityFields, $skip: p.offset, $top: p.limit + 1};
  const collection = type === 'article' ? '/api/admin/projects/' + encodeURIComponent(args.project) + '/articles' : '/api/issues';
  if (type === 'issue') params.query = 'project: {' + args.project + '}' + (query ? ' (' + query + ')' : '');
  const result = page(api.get(collection, params), p);
  result.items = result.items.map(d => {
    const m = metadata(api, type, d);
    if (m.project !== args.project) fail('REST_PROJECT_MISMATCH');
    return m;
  });
  result.fetchedAt = Date.now();
  return result;
};

exports.getDocument = function (ctx) {
  const api = client(ctx), args = ctx.arguments || {}, type = kind(args.kind);
  const offset = integer(args.contentOffset, 0, 0, 10000000);
  const limit = integer(args.contentLimit, 16000, 1, 32000);
  if (offset > 0 && args.expectedUpdatedAt === undefined) fail('REVISION_REQUIRED');
  const fields = identityFields + (type === 'issue' ? ',description,customFields(name,value(id,name,text,login)),tags(name)' : ',content,parentArticle(id,idReadable),tags(name)');
  const d = parent(api, type, args.id, fields);
  if (args.expectedUpdatedAt !== undefined && args.expectedUpdatedAt !== d.updated) fail('DOCUMENT_CHANGED');
  const text = (type === 'issue' ? d.description : d.content) || '';
  if (typeof text !== 'string') fail('REST_INVALID_DOCUMENT');
  if (offset > text.length || (offset > 0 && /[\uD800-\uDBFF]/.test(text.charAt(offset - 1)) && /[\uDC00-\uDFFF]/.test(text.charAt(offset)))) fail('INVALID_CONTENT_OFFSET');
  let end = Math.min(text.length, offset + limit);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text.charAt(end - 1)) && /[\uDC00-\uDFFF]/.test(text.charAt(end))) end += 1;
  const result = metadata(api, type, d);
  result.content = text.slice(offset, end);
  result.contentOffset = offset;
  result.contentLength = text.length;
  result.nextContentOffset = end < text.length ? end : null;
  result.complete = end === text.length;
  result.offsetUnit = 'utf16';
  result.fetchedAt = Date.now();
  result.attributes = {tags: d.tags || []};
  if (type === 'issue') result.attributes.customFields = d.customFields || [];
  else result.attributes.parentArticle = d.parentArticle || null;
  return result;
};

exports.getComments = function (ctx) {
  const api = client(ctx), args = ctx.arguments || {}, type = kind(args.kind), p = paging(args);
  const d = parent(api, type, args.id);
  if (args.expectedUpdatedAt !== undefined && args.expectedUpdatedAt !== d.updated) fail('DOCUMENT_CHANGED');
  const result = page(api.get('/api/' + type + 's/' + entityId(args.id) + '/comments', {
    fields: 'id,text,created,updated,deleted,author(login,name)', $skip: p.offset, $top: p.limit + 1
  }), p);
  if (result.items.some(item => !item || typeof item.id !== 'string' || typeof item.text !== 'string')) fail('REST_INVALID_COMMENT');
  result.documentId = metadata(api, type, d).id;
  result.updatedAt = d.updated;
  result.fetchedAt = Date.now();
  return result;
};

exports.getIssueHistory = function (ctx) {
  const api = client(ctx), args = ctx.arguments || {}, p = paging(args);
  if (p.offset > 0 && args.end === undefined) fail('HISTORY_END_REQUIRED');
  const end = integer(args.end, Date.now(), 0, Number.MAX_SAFE_INTEGER);
  const start = integer(args.start, 0, 0, end);
  const allowed = ['CustomFieldCategory', 'CommentsCategory', 'DescriptionCategory', 'SummaryCategory', 'IssueCreatedCategory', 'LinksCategory', 'TagsCategory'];
  const categories = args.categories === undefined ? ['CustomFieldCategory'] : args.categories;
  if (!Array.isArray(categories) || !categories.length || categories.length > allowed.length || categories.some(c => allowed.indexOf(c) === -1)) fail('INVALID_CATEGORIES');
  const d = parent(api, 'issue', args.id);
  const result = page(api.get('/api/issues/' + entityId(args.id) + '/activities', {
    fields: 'id,timestamp,author(login,name),field(name),category(id),added(id,name,text),removed(id,name,text),target(id)',
    categories: categories.join(','), start, end, reverse: false, $skip: p.offset, $top: p.limit + 1
  }), p);
  if (result.items.some(item => !item || typeof item.id !== 'string' || !Number.isSafeInteger(item.timestamp))) fail('REST_INVALID_ACTIVITY');
  result.documentId = metadata(api, 'issue', d).id;
  result.start = start;
  result.end = end;
  result.categories = categories;
  result.fetchedAt = Date.now();
  return result;
};
