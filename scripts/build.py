#!/usr/bin/env python3
"""Build a deterministic app archive containing only reviewed runtime files."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FILES = ('manifest.json', 'settings.json', 'lib.js', 'list-documents.js',
         'get-document.js', 'get-comments.js', 'get-issue-history.js')


def main():
    manifest = json.loads((ROOT / 'app/manifest.json').read_text())
    assert manifest['version'] == json.loads((ROOT / 'package.json').read_text())['version']
    target = ROOT / 'dist/app'
    target.mkdir(parents=True, exist_ok=True)
    for stale in target.iterdir():
        if stale.name not in FILES:
            raise RuntimeError('Unexpected file in build directory: ' + stale.name)
    for name in FILES:
        source = ROOT / 'app' / name
        if source.suffix == '.js':
            subprocess.run(['node', '--check', str(source)], check=True)
        else:
            json.loads(source.read_text())
        shutil.copyfile(source, target / name)
    archive = ROOT / 'dist' / f"youtrack-mcp-documents-{manifest['version']}.zip"
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as out:
        for name in sorted(FILES):
            info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            out.writestr(info, (target / name).read_bytes())
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix('.zip.sha256').write_text(f'{digest}  {archive.name}\n')
    print(f'Built {len(FILES)} files: {archive.name}; sha256={digest}')


if __name__ == '__main__':
    main()
