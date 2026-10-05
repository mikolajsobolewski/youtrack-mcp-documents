#!/usr/bin/env python3
"""Upload the built app; optionally configure a single-user read-only exporter.

Uses the app-management endpoints used by @jetbrains/youtrack-apps-tools 1.0.3.
Credentials stay in memory and never appear in arguments or output.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default=os.environ.get('YT_URL'))
    parser.add_argument('--token-file', type=Path, default=Path.home() / '.config/youtrack-token')
    parser.add_argument('--configure', action='store_true')
    parser.add_argument('--exporter-login')
    parser.add_argument('--projects', help='Comma-separated project keys')
    args = parser.parse_args()
    base = (args.url or '').rstrip('/')
    if not re.fullmatch(r'https://[A-Za-z0-9.-]+(?::[0-9]+)?(?:/[A-Za-z0-9._~-]+)*', base):
        parser.error('--url must be a YouTrack HTTPS base URL')
    token = os.environ.get('YT_TOKEN', '').strip()
    if not token and args.token_file.is_file():
        token = args.token_file.read_text().strip()
    if not token:
        parser.error('Set YT_TOKEN or provide --token-file')
    if args.configure and (not args.exporter_login or not args.projects):
        parser.error('--configure requires --exporter-login and --projects')
    if args.projects and any(not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]*', p.strip()) for p in args.projects.split(',')):
        parser.error('Invalid project key')

    def request(method, path, body=None, content_type='application/json'):
        req = urllib.request.Request(base + path, data=body, method=method, headers={
            'Authorization': 'Bearer ' + token, 'Accept': 'application/json', 'Content-Type': content_type})
        try:
            with urllib.request.urlopen(req, timeout=60) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            try:
                detail = json.loads(exc.read()).get('error_description', '')
            except (ValueError, AttributeError):
                detail = ''
            detail = str(detail).replace(token, '[REDACTED]')[:1200]
            raise RuntimeError(f'{method} {path.split("?")[0]} failed: HTTP {exc.code} {detail}') from None

    if args.configure:
        identity = request('GET', '/api/users/me?fields=login')
        if identity.get('login') != args.exporter_login:
            raise RuntimeError('Configured exporter must own the REST token')
        for project in args.projects.split(','):
            request('GET', '/api/admin/projects/' + project.strip() + '?fields=id,shortName')
    manifest = json.loads((ROOT / 'app/manifest.json').read_text())
    archive = ROOT / 'dist' / f"youtrack-mcp-documents-{manifest['version']}.zip"
    payload = archive.read_bytes()
    digest = hashlib.sha256(payload).hexdigest()
    if archive.with_suffix('.zip.sha256').read_text().split()[0] != digest:
        raise RuntimeError('Archive checksum mismatch')
    with zipfile.ZipFile(archive) as package:
        for name in package.namelist():
            if package.read(name) != (ROOT / 'app' / name).read_bytes():
                raise RuntimeError('Archive is stale: run npm run check')
    boundary = 'youtrack-mcp-' + uuid.uuid4().hex
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{archive.name}"\r\n'
            'Content-Type: application/zip\r\n\r\n').encode() + payload + f'\r\n--{boundary}--\r\n'.encode()
    installed = request('POST', '/api/admin/apps/import', body, 'multipart/form-data; boundary=' + boundary)
    app_id = installed.get('id')
    if not app_id or not re.fullmatch(r'\d+-\d+', app_id):
        raise RuntimeError('Upload did not return an app ID')
    print(f"Uploaded {manifest['name']} {manifest['version']}, app={app_id}, sha256={digest}")
    if args.configure:
        settings = {'youtrackUrl': base, 'exporterLogin': args.exporter_login,
                    'restToken': token, 'projectKeys': args.projects}
        result = request('POST', f'/api/admin/apps/{app_id}/globalConfig?fields=id,enabled,missingRequiredSettings',
                         json.dumps({'enabled': True, 'globalSettings': json.dumps(settings)}).encode())
        if result.get('enabled') is not True or result.get('missingRequiredSettings'):
            raise RuntimeError('App configuration is not active or required settings are missing')
        print('Configured exporter identity and project scope; enabled=true; secrets omitted')
    print(base + '/mcp?customToolPackages=' + manifest['name'])


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('DEPLOY FAILED: ' + (str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__), file=sys.stderr)
        sys.exit(2)
