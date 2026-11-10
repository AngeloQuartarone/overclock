#!/usr/bin/env python3
"""Regenerate the precache list and cache version in sw.js.

    python3 tools/build_sw.py [SITE_ROOT]           # rewrite SITE_ROOT/sw.js (default: the repo root)
    python3 tools/build_sw.py [SITE_ROOT] --check   # exit 1 if SITE_ROOT/sw.js is stale (for CI)

Site files (everything the game needs, nothing else):
    index.html, manifest.webmanifest, js/*.js, vendor/** and icons/*.png
Never listed: sw.js itself, server.py, qr.py, tests/, tools/, data/, dotfiles, README/LICENSE files
(license texts under vendor/ are deployed but not precached: the game never loads them).

VERSION = first 12 hex digits of sha256 over the files sorted by path, hashing for each one
its relative path (UTF-8), a NUL byte, and its content. Only the lines between `// BUILD:START`
and `// BUILD:END` in sw.js are rewritten; running it twice changes nothing.
"""
import hashlib
import sys
from pathlib import Path

START, END = '// BUILD:START', '// BUILD:END'


def skipped(rel):
    parts = rel.split('/')
    name = parts[-1]
    return (any(p.startswith('.') for p in parts)
            or name.upper().startswith(('LICENSE', 'LICENCE', 'README', 'COPYING'))
            or name.lower().endswith(('.md', '.txt')))


def site_files(root):
    """Relative POSIX paths of the files to precache, sorted."""
    found = []
    for name in ('index.html', 'manifest.webmanifest'):
        if (root / name).is_file():
            found.append(name)
    found += [p.relative_to(root).as_posix() for p in (root / 'js').glob('*.js') if p.is_file()]
    found += [p.relative_to(root).as_posix() for p in (root / 'vendor').rglob('*') if p.is_file()]
    found += [p.relative_to(root).as_posix() for p in (root / 'icons').glob('*.png') if p.is_file()]
    return sorted(rel for rel in set(found) if not skipped(rel))


def version(root, files):
    h = hashlib.sha256()
    for rel in files:
        h.update(rel.encode('utf-8') + b'\0')
        h.update((root / rel).read_bytes())
    return h.hexdigest()[:12]


def block(root, files):
    urls = ['./' if rel == 'index.html' else './' + rel for rel in files]
    urls.sort(key=lambda u: (u != './', u))                       # the page first, then alphabetical
    lines = [f"const VERSION = '{version(root, files)}';", 'const PRECACHE = [']
    lines += [f"  '{u}'," for u in urls]
    lines.append('];')
    return lines


def main(argv):
    check = '--check' in argv
    args = [a for a in argv if a != '--check']
    if len(args) > 1 or any(a.startswith('-') for a in args):
        sys.exit(__doc__)
    root = Path(args[0] if args else Path(__file__).resolve().parent.parent).resolve()
    sw = root / 'sw.js'
    if not sw.is_file():
        sys.exit(f'build_sw: {sw} not found')

    files = site_files(root)
    if 'index.html' not in files:
        sys.exit(f'build_sw: {root / "index.html"} not found')

    text = sw.read_text(encoding='utf-8')
    lines = text.split('\n')
    try:
        a = next(i for i, l in enumerate(lines) if l.strip() == START)
        b = next(i for i, l in enumerate(lines) if l.strip() == END and i > a)
    except StopIteration:
        sys.exit(f'build_sw: markers {START} / {END} not found in {sw}')
    new = '\n'.join(lines[:a + 1] + block(root, files) + lines[b:])

    ver = version(root, files)
    if new == text:
        print(f'build_sw: {sw} up to date (version {ver}, {len(files)} files)')
        return 0
    if check:
        print(f'build_sw: {sw} is stale, run: python3 tools/build_sw.py', file=sys.stderr)
        return 1
    sw.write_text(new, encoding='utf-8')
    print(f'build_sw: wrote {sw} (version {ver}, {len(files)} files)')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
