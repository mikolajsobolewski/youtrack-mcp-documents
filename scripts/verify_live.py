#!/usr/bin/env python3
"""Read-only MCP/REST comparison. Prints counts, never document contents or tokens.

Install requirements-live.txt into an isolated environment before running.
"""
import argparse
import asyncio
import hashlib
import json
import logging
import os
from pathlib import Path
import sys
import urllib.parse
import urllib.request

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

logging.disable(logging.CRITICAL)
TOOLS = {'rag_list_documents', 'rag_get_document', 'rag_get_comments', 'rag_get_issue_history'}


async def verify(args):
    token = os.environ.get('YT_TOKEN', '').strip() or args.token_file.read_text().strip()
    base = args.url.rstrip('/')
    if urllib.parse.urlsplit(base).scheme != 'https':
        raise ValueError('HTTPS URL required')

    def rest(path, **params):
        req = urllib.request.Request(base + path + '?' + urllib.parse.urlencode(params),
                                     headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/json'})
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)

    def rest_all(path, **params):
        result = []
        for offset in range(0, 10000, 100):
            items = rest(path, **params, **{'$skip': offset, '$top': 100})
            assert isinstance(items, list), 'REST collection response is invalid'
            result.extend(items)
            if len(items) < 100:
                return result
        raise AssertionError('REST verification page budget exceeded')

    endpoint = base + '/mcp?customToolPackages=youtrack-mcp-documents'
    async with streamablehttp_client(endpoint, headers={'Authorization': 'Bearer ' + token}, timeout=45) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            listing = await session.list_tools()
            names = {t.name for t in listing.tools}
            assert TOOLS <= names, 'Custom tools missing'
            assert {'get_issue', 'get_article', 'update_issue', 'create_issue'} <= names, 'Built-in tools missing'
            print(f'Tool discovery: {len(TOOLS)} custom tools; built-in tools preserved', flush=True)

            async def call(name, params):
                result = await session.call_tool(name, params)
                if result.isError:
                    message = ' '.join(c.text for c in result.content if c.type == 'text').replace(token, '[REDACTED]')
                    raise AssertionError(name + ': ' + message[:400])
                if result.structuredContent:
                    return result.structuredContent
                return json.loads(next(c.text for c in result.content if c.type == 'text'))

            async def pages(name, params):
                result, offset = [], 0
                for _ in range(10000):
                    page = await call(name, {**params, 'offset': offset, 'limit': 2})
                    result.extend(page['items'])
                    if 'end' in page:
                        params['end'] = page['end']
                    if page['nextOffset'] is None:
                        assert page['complete'] is True
                        return result
                    assert page['nextOffset'] > offset, 'Non-advancing pagination'
                    offset = page['nextOffset']
                raise AssertionError('MCP verification page budget exceeded')

            for kind in ('issue', 'article'):
                page = await call('rag_list_documents', {'kind': kind, 'project': args.project, 'limit': 1})
                assert page['items'], 'Positive control: expected a nonempty project'
                collection = '/api/admin/projects/' + urllib.parse.quote(args.project, safe='') + '/articles' if kind == 'article' else '/api/issues'
                filters = {} if kind == 'article' else {'query': 'project: {' + args.project + '}'}
                expected = rest(collection, fields='id', **filters, **{'$top': 2, '$skip': 0})
                assert page['items'][0]['sourceId'] == expected[0]['id'], kind + ' first inventory position differs from REST'
                if len(expected) > 1:
                    assert page['nextOffset'] == 1
                    second = await call('rag_list_documents', {'kind': kind, 'project': args.project, 'limit': 1, 'offset': 1})
                    assert second['items'][0]['sourceId'] == expected[1]['id'], kind + ' second inventory position differs from REST'
                print(f'{kind} inventory: first two positions match REST', flush=True)

            for kind, entity in [('article', args.article), ('issue', args.issue)]:
                content, offset, revision, count = '', 0, None, 0
                while True:
                    params = {'kind': kind, 'id': entity, 'contentOffset': offset, 'contentLimit': 4000}
                    if revision is not None:
                        params['expectedUpdatedAt'] = revision
                    page = await call('rag_get_document', params)
                    revision = page['updatedAt']
                    count += 1
                    content += page['content']
                    if page['nextContentOffset'] is None:
                        assert page['complete'] is True
                        break
                    assert page['nextContentOffset'] > offset
                    offset = page['nextContentOffset']
                    assert count < 1000
                field = 'content' if kind == 'article' else 'description'
                expected = rest('/api/' + kind + 's/' + entity, fields=field + ',updated')
                assert revision == expected['updated'], 'Source changed during verification; retry'
                assert content == (expected[field] or ''), 'Text differs from REST'
                print(f'{entity}: {count} text pages, {len(content)} characters, SHA256={hashlib.sha256(content.encode()).hexdigest()}', flush=True)
                comments = await pages('rag_get_comments', {'kind': kind, 'id': entity})
                expected_comments = rest_all('/api/' + kind + 's/' + entity + '/comments', fields='id,text')
                assert [(c['id'], c['text']) for c in comments] == [(c['id'], c['text']) for c in expected_comments]
                print(f'{entity}: all {len(comments)} comments match REST', flush=True)

            params = {'id': args.issue}
            events = await pages('rag_get_issue_history', params)
            expected_events = rest_all('/api/issues/' + args.issue + '/activities',
                                       fields='id,timestamp,field(name),added(name),removed(name)',
                                       categories='CustomFieldCategory', end=params['end'], reverse='false')
            assert [e['id'] for e in events] == [e['id'] for e in expected_events]
            # Projections include extra IDs in MCP: compare transition value names separately.
            def values(items):
                return [(e['id'], e['timestamp'], [v.get('name') for v in e.get('added', [])],
                         [v.get('name') for v in e.get('removed', [])]) for e in items
                        if (e.get('field') or {}).get('name') == 'State']
            assert values(events) == values(expected_events)
            assert values(events), 'Positive control: no State changes compared'
            print(f'{args.issue}: {len(events)} history events; {len(values(events))} State transitions match REST', flush=True)

            for name, params, code in [
                ('rag_list_documents', {'kind': 'issue', 'project': 'FORBIDDEN'}, 'PROJECT_NOT_ALLOWED'),
                ('rag_get_document', {'kind': 'article', 'id': args.article, 'expectedUpdatedAt': 0}, 'DOCUMENT_CHANGED'),
                ('rag_get_issue_history', {'id': args.issue, 'offset': 1}, 'HISTORY_END_REQUIRED')
            ]:
                result = await session.call_tool(name, params)
                assert result.isError and any(code in getattr(c, 'text', '') for c in result.content), 'Negative control failed: ' + code
            print('Negative controls: 3/3 explicit rejections; verification passed', flush=True)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--url', required=True)
    p.add_argument('--project', required=True)
    p.add_argument('--issue', required=True)
    p.add_argument('--article', required=True)
    p.add_argument('--token-file', type=Path, default=Path.home() / '.config/youtrack-token')
    async def bounded():
        async with asyncio.timeout(300):
            await verify(p.parse_args())
    asyncio.run(bounded())


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        def describe(error):
            if isinstance(error, BaseExceptionGroup):
                return '; '.join(describe(child) for child in error.exceptions)
            return str(error) if isinstance(error, AssertionError) else type(error).__name__
        print('VERIFY FAILED: ' + describe(exc), file=sys.stderr)
        sys.exit(2)
