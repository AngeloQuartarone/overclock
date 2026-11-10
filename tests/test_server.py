"""Tests for server.py (standard library only).

    python3 -m unittest discover -s tests -v

Every test class starts a real server on a free port, in a thread, with a temporary database and a small
fake site (so the tests don't depend on the real game files). PBKDF2 rounds and rate limits are lowered to keep it fast.
"""
import base64
import contextlib
import hashlib
import http.client
import io
import itertools
import json
import math
import os
import shutil
import sqlite3
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest
import warnings
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import qr  # noqa: E402
import server  # noqa: E402

server.ROUNDS = 1000                                                        # fast hashing in tests
BIG = {'auth': (10000, 1), 'games': (10000, 1), 'import': (10000, 1), 'challenge': (10000, 1)}
IMPORTMAP = '\n  {"imports": {"three": "./vendor/three/build/three.module.js"}}\n  '
_names = itertools.count(1)
_ids = itertools.count(1)


def new_name():
    return f'pl{next(_names)}x'


def iso(dt):
    return dt.strftime('%Y-%m-%dT%H:%M:%S.') + f'{dt.microsecond // 1000:03d}Z'


def game(**kw):
    g = dict(id=f'game{next(_ids):08d}', played=iso(datetime.now(timezone.utc) - timedelta(minutes=5)), cpu='pipeline',
             mode='classica', seed=123456, challenge=None, score=5000, time_ms=60000, finished=True, crashed=False,
             ok=40, perfect=10, good=20, slow=10, glitches=1, combo=12, peak=3.2)
    g.update(kw)
    return g


# an independent implementation of the export hash from the contract
def js_round(x):
    return math.floor(x + 0.5)


def expected_hash(games):
    def line(g):
        return '|'.join(str(x) for x in [
            g['id'], g['played'], g['cpu'], g['mode'], g['seed'], g['challenge'] or '', g['score'], g['time_ms'],
            1 if g['finished'] else 0, 1 if g['crashed'] else 0, g['ok'], g['perfect'], g['good'], g['slow'],
            g['glitches'], g['combo'], js_round(g['peak'] * 10)])
    return hashlib.sha256(('overclock-results-v1\n' + '\n'.join(line(g) for g in games)).encode('utf-8')).hexdigest()


def export(game_list, **kw):
    doc = {'format': 'overclock-results', 'version': 1, 'exported': iso(datetime.now(timezone.utc)), 'games': game_list,
           'hash': expected_hash(game_list)}
    doc.update(kw)
    return doc


def make_site(root):
    """A tiny copy of the site layout, plus files that must never be served."""
    files = {
        'index.html': f'<!doctype html><title>t</title><script type="importmap">{IMPORTMAP}</script>'
                      '<script type="module" src="js/main.js"></script><script>\r\nwindow.x = 1;\r\n</script>',
        'manifest.webmanifest': '{"name": "Overclock"}',
        'sw.js': 'self.addEventListener("fetch", () => {});',
        'js/main.js': 'export {};',
        'js/.hidden.js': 'secret',
        'icons/favicon-32.png': '\x89PNG fake',
        'vendor/three/build/three.module.js': 'export const REVISION = "1";',
        'vendor/three/LICENSE': 'MIT',
        'vendor/three/evil.py': 'print(1)',
        'vendor/fonts/plex-mono.css': '@font-face {}',
        'server.py': 'SECRET',
        'data/overclock.db': 'SECRET',
        '.git/config': 'SECRET',
    }
    for name, content in files.items():
        p = root / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding='latin-1')
    (root / '..' / 'outside.js').resolve().write_text('SECRET')
    try:
        os.symlink(root.parent / 'outside.js', root / 'vendor' / 'three' / 'link.js')
    except OSError:
        pass


class ServerTest(unittest.TestCase):
    registration = 'open'
    invite_code = None
    ssl_context = None

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix='overclock-test-'))
        cls.site = cls.tmp / 'site'
        make_site(cls.site)
        cls.store = server.Store(cls.tmp / 'db' / 'test.db')
        cls.httpd = server.make_server(cls.store, '127.0.0.1', 0, cls.registration, cls.invite_code,
                                       ['https://friend.example'], limits=server.RateLimiter(BIG, lockout=(1000, 60)),
                                       ssl_context=cls.ssl_context, root=cls.site, quiet=True)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        self.httpd.RequestHandlerClass.limits = server.RateLimiter(BIG, lockout=(1000, 60))

    def conn(self):
        return http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)

    def request(self, method, path, body=None, token=None, headers=None, raw=None):
        h = dict(headers or {})
        data = raw
        if body is not None:
            data = json.dumps(body).encode()
            h.setdefault('Content-Type', 'application/json')
        if token:
            h['Authorization'] = f'Bearer {token}'
        c = self.conn()
        try:
            c.request(method, path, body=data, headers=h)
            r = c.getresponse()
            payload = r.read()
            hdrs = {k.lower(): v for k, v in r.getheaders()}
        finally:
            c.close()
        if payload and hdrs.get('content-type', '').startswith('application/json'):
            payload = json.loads(payload)
        return r.status, hdrs, payload

    def register(self, name=None, password='password1', **extra):
        name = name or new_name()
        st, _, d = self.request('POST', '/api/register', dict(name=name, password=password, **extra))
        self.assertEqual(st, 200, d)
        return name, d['token']

    def assertError(self, resp, status, code):
        st, _, d = resp
        self.assertEqual(st, status, d)
        self.assertEqual(d['code'], code, d)
        self.assertIsInstance(d['error'], str)
        return d


class AccountTests(ServerTest):
    def test_info(self):
        st, h, d = self.request('GET', '/api/info')
        self.assertEqual(st, 200)
        self.assertEqual(d, {'app': 'overclock', 'version': 2, 'registration': 'open', 'cpus': list(server.CPUS),
                             'password_min': 8, 'password_max': 128})

    def test_register_login_logout(self):
        name, token = self.register()
        self.assertEqual(self.request('GET', '/api/me', token=token)[2]['user'], {'name': name})
        st, _, d = self.request('POST', '/api/login', {'name': name.upper(), 'password': 'password1'})
        self.assertEqual(st, 200)
        self.assertEqual(d['user'], {'name': name})
        self.assertEqual(self.request('POST', '/api/logout', token=token)[2], {'ok': True})
        self.assertIsNone(self.request('GET', '/api/me', token=token)[2]['user'])
        self.assertError(self.request('POST', '/api/games', game(), token=token), 401, 'auth_required')

    def test_password_policy(self):
        self.assertError(self.request('POST', '/api/register', {'name': new_name(), 'password': 'x' * 7}), 400, 'bad_password')
        self.assertError(self.request('POST', '/api/register', {'name': new_name(), 'password': 'x' * 129}), 400, 'bad_password')
        self.register(password='x' * 8)
        self.register(password='x' * 128)

    def test_bad_name_and_taken(self):
        self.assertError(self.request('POST', '/api/register', {'name': 'a b', 'password': 'password1'}), 400, 'bad_name')
        name, _ = self.register()
        self.assertError(self.request('POST', '/api/register', {'name': name.upper(), 'password': 'password1'}), 409, 'name_taken')

    def test_strict_types(self):
        self.assertError(self.request('POST', '/api/register', {'name': new_name(), 'password': 12345678}), 400, 'bad_value')
        self.assertError(self.request('POST', '/api/register', {'name': ['x'], 'password': 'password1'}), 400, 'bad_value')
        self.assertError(self.request('POST', '/api/login', raw=b'[1]', headers={'Content-Type': 'application/json'}), 400, 'bad_request')
        self.assertError(self.request('POST', '/api/login', raw=b'{"name": NaN}', headers={'Content-Type': 'application/json'}), 400, 'bad_request')
        self.assertError(self.request('POST', '/api/login', raw=b'{"name": "x"}', headers={'Content-Type': 'text/plain'}), 415, 'bad_content_type')
        self.assertError(self.request('POST', '/api/login', raw=b'{' + b' ' * 5000 + b'}', headers={'Content-Type': 'application/json'}),
                         413, 'body_too_large')

    def test_wrong_password_and_unknown_user(self):
        name, _ = self.register()
        self.assertError(self.request('POST', '/api/login', {'name': name, 'password': 'nope-nope'}), 401, 'bad_credentials')
        self.assertError(self.request('POST', '/api/login', {'name': 'nobody99', 'password': 'nope-nope'}), 401, 'bad_credentials')

    def test_legacy_password_login_and_rehash(self):
        name, salt = new_name(), os.urandom(16)
        con = self.store.open()
        with con:
            con.execute('INSERT INTO users (name, name_key, salt, hash, rounds, created) VALUES (?, ?, ?, ?, ?, ?)',
                        (name, name.casefold(), salt, hashlib.pbkdf2_hmac('sha256', b'abcd', salt, 500), 500, server.now()))
        con.close()
        st, _, d = self.request('POST', '/api/login', {'name': name, 'password': 'abcd'})   # 4 chars: still fine for old accounts
        self.assertEqual(st, 200, d)
        con = self.store.open()
        row = con.execute('SELECT rounds, salt, hash FROM users WHERE name_key = ?', (name.casefold(),)).fetchone()
        con.close()
        self.assertEqual(row['rounds'], server.ROUNDS)
        self.assertEqual(hashlib.pbkdf2_hmac('sha256', b'abcd', row['salt'], server.ROUNDS), row['hash'])
        self.assertEqual(self.request('POST', '/api/login', {'name': name, 'password': 'abcd'})[0], 200)

    def test_session_expiry(self):
        name, token = self.register()
        con = self.store.open()
        with con:
            con.execute('UPDATE sessions SET last_used = ? WHERE token_hash = ?', (server.ago(days=91), server.sha(token)))
        con.close()
        self.assertIsNone(self.request('GET', '/api/me', token=token)[2]['user'])
        con = self.store.open()
        self.assertIsNone(con.execute('SELECT 1 FROM sessions WHERE token_hash = ?', (server.sha(token),)).fetchone())
        con.close()
        # a session in use gets its expiry pushed forward; cleanup() removes only the expired ones
        _, token2 = self.register()
        _, token3 = self.register()
        con = self.store.open()
        with con:
            con.execute('UPDATE sessions SET last_used = ? WHERE token_hash = ?', (server.ago(days=89), server.sha(token2)))
            con.execute('UPDATE sessions SET last_used = ? WHERE token_hash = ?', (server.ago(days=200), server.sha(token3)))
        con.close()
        self.assertIsNotNone(self.request('GET', '/api/me', token=token2)[2]['user'])
        con = self.store.open()
        used = con.execute('SELECT last_used FROM sessions WHERE token_hash = ?', (server.sha(token2),)).fetchone()[0]
        con.close()
        self.assertGreater(used, server.ago(minutes=5))
        self.assertGreaterEqual(self.store.cleanup(), 1)
        self.assertIsNone(self.request('GET', '/api/me', token=token3)[2]['user'])


class ClosedRegistrationTests(ServerTest):
    registration = 'closed'

    def test_closed(self):
        self.assertEqual(self.request('GET', '/api/info')[2]['registration'], 'closed')
        self.assertError(self.request('POST', '/api/register', {'name': new_name(), 'password': 'password1'}), 403, 'registration_closed')


class InviteRegistrationTests(ServerTest):
    registration = 'invite'
    invite_code = 'SECRET42'

    def test_invite(self):
        self.assertEqual(self.request('GET', '/api/info')[2]['registration'], 'invite')
        self.assertError(self.request('POST', '/api/register', {'name': new_name(), 'password': 'password1'}), 403, 'bad_invite')
        self.assertError(self.request('POST', '/api/register', {'name': new_name(), 'password': 'password1', 'invite': 'WRONG'}),
                         403, 'bad_invite')
        self.assertError(self.request('POST', '/api/register', {'name': new_name(), 'password': 'password1', 'invite': 'sècret'}),
                         403, 'bad_invite')
        self.register(invite=' secret42 ')


class GameTests(ServerTest):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()

    def setUp(self):
        super().setUp()
        self.name, self.token = self.register()

    def save(self, **kw):
        return self.request('POST', '/api/games', game(**kw), token=self.token)

    def count(self):
        con = self.store.open()
        try:
            return con.execute('SELECT COUNT(*) FROM games g JOIN users u ON u.id = g.user_id WHERE u.name = ?', (self.name,)).fetchone()[0]
        finally:
            con.close()

    def test_save(self):
        st, _, d = self.save(score=4000)
        self.assertEqual(st, 200, d)
        self.assertEqual(d['cpu'], 'pipeline')
        self.assertEqual(d['value'], 4000)
        self.assertTrue(d['best'])
        self.assertEqual(d['record'], 4000)
        self.assertIsInstance(d['rank'], int)
        self.assertIsNone(d['challenge'])
        self.assertNotIn('duplicate', d)
        self.assertFalse(self.save(score=3000)[2]['best'])

    def test_old_client_without_id_and_played(self):
        g = game()
        del g['id'], g['played']
        st, _, d = self.request('POST', '/api/games', g, token=self.token)
        self.assertEqual(st, 200, d)
        self.request('POST', '/api/games', g, token=self.token)
        self.assertEqual(self.count(), 2)                                    # no id: no dedupe

    def test_dedupe(self):
        g = game(score=2500)
        st, _, a = self.request('POST', '/api/games', g, token=self.token)
        self.assertEqual(st, 200, a)
        st, _, b = self.request('POST', '/api/games', g, token=self.token)
        self.assertEqual(st, 200, b)
        self.assertTrue(b.pop('duplicate'))
        self.assertFalse(b['best'])
        self.assertEqual(b['id'], a['id'])
        self.assertEqual(set(a), set(b))
        self.assertEqual(self.count(), 1)
        # the same client id from another user is a different game
        _, other = self.register()
        self.assertNotIn('duplicate', self.request('POST', '/api/games', g, token=other)[2])

    def test_played(self):
        played = datetime.now(timezone.utc) - timedelta(days=3)
        g = game(played=iso(played))
        self.assertEqual(self.request('POST', '/api/games', g, token=self.token)[0], 200)
        con = self.store.open()
        created = con.execute('SELECT created, source FROM games WHERE client_id = ?', (g['id'],)).fetchone()
        con.close()
        self.assertEqual(created['created'], server.local_time(played.replace(microsecond=played.microsecond // 1000 * 1000)))
        self.assertEqual(created['source'], 'live')
        self.assertError(self.save(played=iso(datetime.now(timezone.utc) + timedelta(days=2))), 400, 'bad_played')
        self.assertError(self.save(played='2026-11-10 21:39:12'), 400, 'bad_played')
        self.assertError(self.save(played='2026-02-30T21:39:12.000Z'), 400, 'bad_played')
        self.assertError(self.save(id='short'), 400, 'bad_id')
        self.assertError(self.save(id='bad id with spaces'), 400, 'bad_id')

    def test_types(self):
        self.assertError(self.save(score=5000.0), 400, 'bad_value')
        self.assertError(self.save(score=True), 400, 'bad_value')
        self.assertError(self.save(score='5000'), 400, 'bad_value')
        self.assertError(self.save(score=-10), 400, 'bad_value')
        self.assertError(self.save(finished=1), 400, 'bad_value')
        self.assertError(self.save(peak='3'), 400, 'bad_value')
        self.assertError(self.save(mode='allenamento'), 400, 'unknown_mode')
        self.assertError(self.save(mode=['classica']), 400, 'unknown_mode')
        self.assertError(self.save(cpu='z80'), 400, 'unknown_cpu')
        self.assertError(self.save(challenge=5), 400, 'bad_value')

    def test_plausibility(self):
        cases = [
            (dict(finished=True, crashed=True), 'finished_crashed'),
            (dict(score=5005), 'score_step'),
            (dict(combo=31), 'combo'),
            (dict(score=400 * 30 + 40 * 10 + 150 * 40 + 1210), 'score'),
            (dict(time_ms=900, mode='sopravvivenza'), 'speed'),
            (dict(glitches=5, crashed=True, finished=False), 'glitches'),
            (dict(glitches=4), 'glitches'),
            (dict(ok=60), 'ok'),
            (dict(time_ms=61001), 'time'),
            (dict(mode='sprint', ok=51), 'sprint'),
            (dict(mode='sprint', ok=49, finished=True), 'sprint'),
            (dict(cpu='gpu', peak=18.1), 'peak'),
        ]
        for kw, rule in cases:
            with self.subTest(rule=rule, **{k: str(v) for k, v in kw.items()}):
                d = self.assertError(self.save(**kw), 400, 'implausible')
                self.assertEqual(d['rule'], rule)
        # the limits themselves are accepted
        ok = [dict(score=400 * 30 + 40 * 10 + 150 * 40 + 1200), dict(glitches=4, crashed=True, finished=False),
              dict(glitches=3), dict(time_ms=1000, mode='sopravvivenza'), dict(time_ms=61000), dict(mode='sprint', ok=50, time_ms=90000),
              dict(mode='sprint', ok=30, crashed=True, finished=False), dict(cpu='gpu', peak=18.0),
              dict(cpu='multiciclo', peak=600.0), dict(combo=30), dict(ok=51)]
        for kw in ok:
            with self.subTest(**{k: str(v) for k, v in kw.items()}):
                st, _, d = self.save(**kw)
                self.assertEqual(st, 200, d)

    def test_daily_challenge_live(self):
        today = date.today()
        code = f'D-{today.isoformat()}'
        st, _, d = self.save(challenge=code, cpu=server.daily_cpu(today), seed=server.daily_seed(today))
        self.assertEqual(st, 200, d)
        self.assertEqual(d['challenge']['code'], code)
        self.assertTrue(d['challenge']['daily'])
        self.assertEqual(d['challenge']['rank'], 1)
        y = today - timedelta(days=1)
        self.assertError(self.save(challenge=f'D-{y.isoformat()}', cpu=server.daily_cpu(y), seed=server.daily_seed(y)),
                         400, 'challenge_closed')
        self.assertError(self.save(challenge=code, cpu=server.daily_cpu(today), seed=1), 400, 'challenge_mismatch')

    def test_custom_challenge(self):
        st, _, ch = self.request('POST', '/api/challenges', {'mode': 'sprint', 'cpu': 'gpu', 'seed': 77}, token=self.token)
        self.assertEqual(st, 200, ch)
        st, _, d = self.save(challenge=ch['code'].lower(), mode='sprint', cpu='gpu', seed=77, ok=50, time_ms=40000, peak=10.0)
        self.assertEqual(st, 200, d)
        self.assertEqual(d['challenge']['code'], ch['code'])
        self.assertError(self.save(challenge=ch['code'], mode='sprint', cpu='gpu', seed=78, ok=50, time_ms=40000), 400,
                         'challenge_mismatch')
        self.assertError(self.save(challenge='ZZZZZ'), 400, 'challenge_mismatch')
        st, _, d = self.request('GET', f'/api/challenges/{ch["code"]}')
        self.assertEqual(d['standings'][0]['name'], self.name)


class ImportTests(ServerTest):
    def setUp(self):
        super().setUp()
        self.name, self.token = self.register()

    def post(self, doc, token=None):
        return self.request('POST', '/api/import', doc, token=token or self.token)

    def test_hash_matches_contract(self):
        games = [game(), game(challenge='D-2026-11-10', peak=1.25), game(peak=0.15, finished=False, crashed=True)]
        self.assertEqual(server.export_hash(games), expected_hash(games))
        # Math.round, not Python's round(): halves go up
        self.assertEqual(server.js_round(12.5), 13)
        self.assertEqual(server.js_round(2.5), 3)
        self.assertEqual(server.js_round(0.49999999999999994), 0)
        self.assertEqual(server.js_round(3.2 * 10), 32)
        self.assertEqual(server.js_str(5000.0), '5000')
        self.assertEqual(server.js_str(None), '')

    def test_import_and_duplicates(self):
        games = [game(score=1000 + 10 * i) for i in range(30)]
        doc = export(games)
        self.assertGreater(len(json.dumps(doc)), server.MAX_BODY)            # bigger than the normal limit
        st, _, d = self.post(doc)
        self.assertEqual(st, 200, d)
        self.assertEqual(d, {'imported': 30, 'duplicates': 0, 'rejected': []})
        st, _, d = self.post(doc)
        self.assertEqual(d, {'imported': 0, 'duplicates': 30, 'rejected': []})
        con = self.store.open()
        self.assertEqual(con.execute("SELECT COUNT(*) FROM games WHERE source = 'import'").fetchone()[0], 30)
        con.close()
        # a game saved live and then imported is the same game
        g = game()
        self.request('POST', '/api/games', g, token=self.token)
        self.assertEqual(self.post(export([g]))[2]['duplicates'], 1)

    def test_bad_files(self):
        games = [game()]
        self.assertError(self.post(export(games, hash='0' * 64)), 400, 'bad_hash')
        tampered = export(games)
        tampered['games'][0]['score'] = 9000
        self.assertError(self.post(tampered), 400, 'bad_hash')
        self.assertError(self.post(export(games, format='something')), 400, 'bad_format')
        self.assertError(self.post(export(games, version=2)), 400, 'bad_version')
        self.assertError(self.post(export(games, version=True)), 400, 'bad_version')
        self.assertError(self.post(export(games, games={'a': 1})), 400, 'bad_format')
        self.assertError(self.post(export([], games=[1, 2])), 400, 'bad_format')
        self.assertError(self.request('POST', '/api/import', export(games)), 401, 'auth_required')

    def test_too_many_games(self):
        many = [game() for _ in range(2001)]
        d = self.assertError(self.post(export(many)), 400, 'too_many_games')
        self.assertEqual(d['max'], 2000)
        st, _, d = self.post(export(many[:2000]))
        self.assertEqual(st, 200, d)
        self.assertEqual(d['imported'], 2000)

    def test_body_limit(self):
        # the server answers from the headers alone, without reading a body over the limit
        c = self.conn()
        try:
            c.putrequest('POST', '/api/import')
            c.putheader('Content-Type', 'application/json')
            c.putheader('Authorization', f'Bearer {self.token}')
            c.putheader('Content-Length', str(2 * 1024 * 1024 + 1))
            c.endheaders()
            r = c.getresponse()
            self.assertEqual((r.status, json.loads(r.read())['code']), (413, 'body_too_large'))
        finally:
            c.close()

    def test_rejected_games(self):
        played = datetime.now(timezone.utc) - timedelta(days=3)
        day = played.date()
        near, far = day + timedelta(days=1), day + timedelta(days=2)
        games = [
            game(),                                                         # fine
            game(score=5005),                                               # implausible
            game(id='x'),                                                   # bad id
            game(played='yesterday'),                                       # bad date
            game(played=iso(played), challenge=f'D-{near}', cpu=server.daily_cpu(near), seed=server.daily_seed(near)),
            game(played=iso(played), challenge=f'D-{far}', cpu=server.daily_cpu(far), seed=server.daily_seed(far)),
            game(challenge='QQQQQ'),                                        # another server's challenge: kept, unlinked
            game(played=iso(played), challenge=f'D-{day}', cpu=server.daily_cpu(day), seed=1),
        ]
        st, _, d = self.post(export(games))
        self.assertEqual(st, 200, d)
        self.assertEqual(d['imported'], 3)
        self.assertEqual(d['duplicates'], 0)
        self.assertEqual([(r['index'], r['code']) for r in d['rejected']],
                         [(1, 'implausible'), (2, 'bad_id'), (3, 'bad_played'), (5, 'challenge_closed'), (7, 'challenge_mismatch')])
        self.assertEqual(d['rejected'][0]['rule'], 'score_step')
        self.assertEqual(d['rejected'][0]['id'], games[1]['id'])
        con = self.store.open()
        rows = {r['client_id']: r['challenge'] for r in con.execute('SELECT client_id, challenge FROM games')}
        con.close()
        self.assertEqual(rows[games[4]['id']], f'D-{near}')
        self.assertIsNone(rows[games[6]['id']])


class RateLimitTests(ServerTest):
    def limit(self, **kw):
        lockout = kw.pop('lockout', (1000, 60))
        self.httpd.RequestHandlerClass.limits = server.RateLimiter(dict(BIG, **kw), lockout=lockout)

    def test_auth_per_ip(self):
        name, _ = self.register()
        self.limit(auth=(3, 60))
        for _ in range(3):
            self.assertEqual(self.request('POST', '/api/login', {'name': name, 'password': 'password1'})[0], 200)
        st, h, d = self.request('POST', '/api/login', {'name': name, 'password': 'password1'})
        self.assertEqual((st, d['code']), (429, 'rate_limited'))
        self.assertEqual(h['retry-after'], str(d['retry_after']))
        self.assertGreaterEqual(d['retry_after'], 1)
        self.assertError(self.request('POST', '/api/register', {'name': new_name(), 'password': 'password1'}), 429, 'rate_limited')

    def test_lockout_per_name(self):
        name, _ = self.register()
        self.limit(lockout=(3, 60))
        for _ in range(3):
            self.assertError(self.request('POST', '/api/login', {'name': name, 'password': 'wrong-one'}), 401, 'bad_credentials')
        d = self.assertError(self.request('POST', '/api/login', {'name': name, 'password': 'password1'}), 429, 'locked')
        self.assertGreater(d['retry_after'], 0)
        other, _ = self.register()                                          # other names are not affected
        self.assertEqual(self.request('POST', '/api/login', {'name': other, 'password': 'password1'})[0], 200)

    def test_games_import_challenges_per_user(self):
        _, token = self.register()
        _, token2 = self.register()
        self.limit(games=(2, 60), challenge=(1, 3600), **{'import': (1, 3600)})
        for _ in range(2):
            self.assertEqual(self.request('POST', '/api/games', game(), token=token)[0], 200)
        self.assertError(self.request('POST', '/api/games', game(), token=token), 429, 'rate_limited')
        self.assertEqual(self.request('POST', '/api/games', game(), token=token2)[0], 200)
        self.assertEqual(self.request('POST', '/api/import', export([game()]), token=token)[0], 200)
        self.assertError(self.request('POST', '/api/import', export([game()]), token=token), 429, 'rate_limited')
        self.assertEqual(self.request('POST', '/api/challenges', {'mode': 'classica'}, token=token)[0], 200)
        self.assertError(self.request('POST', '/api/challenges', {'mode': 'classica'}, token=token), 429, 'rate_limited')

    def test_bucket_refill(self):
        t = [0.0]
        rl = server.RateLimiter({'games': (2, 4)}, lockout=(2, 60), clock=lambda: t[0])
        self.assertEqual([rl.hit('games', 1) for _ in range(3)], [0, 0, 2])
        t[0] = 2.0
        self.assertEqual(rl.hit('games', 1), 0)
        self.assertGreater(rl.hit('games', 1), 0)
        rl.failed('bob')
        self.assertEqual(rl.locked('bob'), 0)
        rl.failed('bob')
        self.assertEqual(rl.locked('bob'), 60)
        t[0] = 70.0
        self.assertEqual(rl.locked('bob'), 0)


class HttpTests(ServerTest):
    def test_cors(self):
        pre = {'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type'}
        for origin in ('https://angeloquartarone.github.io', 'https://friend.example', f'http://127.0.0.1:{self.port}'):
            with self.subTest(origin=origin):
                st, h, _ = self.request('OPTIONS', '/api/games', headers=dict(pre, Origin=origin))
                self.assertEqual(st, 204)
                self.assertEqual(h['access-control-allow-origin'], origin)
                self.assertEqual(h['access-control-allow-private-network'], 'true')
                self.assertIn('Authorization', h['access-control-allow-headers'])
                self.assertIn('Accept-Language', h['access-control-allow-headers'])
                self.assertIn('POST', h['access-control-allow-methods'])
                self.assertEqual(h['vary'], 'Origin')
                self.assertNotIn('access-control-allow-credentials', h)
                st, h, _ = self.request('GET', '/api/info', headers={'Origin': origin})
                self.assertEqual(h['access-control-allow-origin'], origin)
        st, h, d = self.request('OPTIONS', '/api/games', headers=dict(pre, Origin='https://evil.example'))
        self.assertEqual((st, d['code']), (403, 'origin_not_allowed'))
        self.assertNotIn('access-control-allow-origin', h)
        st, h, _ = self.request('GET', '/api/info', headers={'Origin': 'https://evil.example'})
        self.assertEqual(st, 200)
        self.assertNotIn('access-control-allow-origin', h)
        self.assertEqual(h['vary'], 'Origin')
        self.assertError(self.request('POST', '/api/login', {'name': 'abc', 'password': 'password1'},
                                      headers={'Origin': 'https://evil.example'}), 403, 'origin_not_allowed')
        self.assertError(self.request('POST', '/api/login', {'name': 'abc', 'password': 'password1'},
                                      headers={'Origin': 'https://angeloquartarone.github.io.evil.example'}), 403, 'origin_not_allowed')

    def test_static_allowlist(self):
        for path, ctype, cache in (('/', 'text/html', 'no-cache'), ('/index.html', 'text/html', 'no-cache'),
                                   ('/js/main.js', 'text/javascript', 'no-cache'), ('/sw.js', 'text/javascript', 'no-cache'),
                                   ('/manifest.webmanifest', 'application/manifest+json', 'no-cache'),
                                   ('/vendor/three/build/three.module.js', 'text/javascript', 'max-age=2592000'),
                                   ('/vendor/three/LICENSE', 'text/plain', 'max-age=2592000'),
                                   ('/vendor/fonts/plex-mono.css', 'text/css', 'max-age'),
                                   ('/icons/favicon-32.png', 'image/png', 'max-age'), ('/favicon.ico', 'image/png', 'max-age'),
                                   ('/js/main.js?v=2', 'text/javascript', 'no-cache')):
            with self.subTest(path=path):
                st, h, _ = self.request('GET', path)
                self.assertEqual(st, 200)
                self.assertTrue(h['content-type'].startswith(ctype), h['content-type'])
                self.assertIn(cache, h['cache-control'])
        st, h, body = self.request('HEAD', '/js/main.js')
        self.assertEqual((st, body), (200, b''))
        for path in ('/server.py', '/data/overclock.db', '/data/', '/js/../server.py', '/%2e%2e/server.py', '/js/%2e%2e/server.py',
                     '/.git/config', '/.git/', '/js/.hidden.js', '/vendor/three/evil.py', '/vendor/../server.py', '//server.py',
                     '/vendor/three/link.js', '/js/Main.JS', '/icons/../server.py', '/vendor//three/LICENSE', '/qr.py',
                     '/README.md', '/js/main.js/', '/vendor/three/build/', '/tests/test_server.py', '/../outside.js'):
            with self.subTest(path=path):
                st, _, body = self.request('GET', path)
                self.assertEqual(st, 404)
                self.assertNotIn(b'SECRET', body if isinstance(body, bytes) else b'')
        self.assertEqual(self.request('POST', '/index.html', {})[0], 405)

    def test_favicon_missing(self):
        icon = self.site / 'icons' / 'favicon-32.png'
        icon.rename(icon.with_suffix('.bak'))
        try:
            self.assertEqual(self.request('GET', '/favicon.ico')[0], 204)
        finally:
            icon.with_suffix('.bak').rename(icon)

    def test_redirect(self):
        st, h, _ = self.request('GET', '/overclock/js/main.js?x=1')
        self.assertEqual((st, h['location']), (301, '/js/main.js?x=1'))
        self.assertEqual(self.request('GET', '/overclock//evil.example/x')[1]['location'], '/evil.example/x')
        self.assertEqual(self.request('GET', '/overclock/\\evil.example')[1]['location'], '/evil.example')

    def test_security_headers(self):
        for method, path in (('GET', '/'), ('GET', '/js/main.js'), ('GET', '/api/info'), ('GET', '/nope'), ('GET', '/api/nope'),
                             ('PUT', '/api/info'), ('DELETE', '/'), ('GET', '/favicon.ico')):
            with self.subTest(path=path, method=method):
                _, h, _ = self.request(method, path)
                self.assertEqual(h['x-content-type-options'], 'nosniff')
                self.assertEqual(h['referrer-policy'], 'no-referrer')
                self.assertEqual(h['x-frame-options'], 'DENY')
                self.assertEqual(h['permissions-policy'], 'camera=(), microphone=(), geolocation=()')
                self.assertEqual(h['cross-origin-opener-policy'], 'same-origin')
                self.assertIn("frame-ancestors 'none'", h['content-security-policy'])

    def test_page_csp(self):
        _, h, _ = self.request('GET', '/')
        csp = dict(p.strip().split(' ', 1) for p in h['content-security-policy'].split(';'))
        want = ["'self'"] + ["'sha256-%s'" % base64.b64encode(hashlib.sha256(s.encode()).digest()).decode()
                             for s in (IMPORTMAP, '\nwindow.x = 1;\n')]
        self.assertEqual(csp['script-src'].split(), want)
        self.assertEqual(csp['default-src'], "'self'")
        self.assertEqual(csp['connect-src'], "'self' https:")
        self.assertEqual(csp['object-src'], "'none'")
        self.assertEqual(csp['base-uri'], "'none'")
        self.assertEqual(csp['img-src'], "'self' data: blob:")
        # the hashes follow the file when it changes
        index = self.site / 'index.html'
        old = index.read_text()
        try:
            index.write_text('<script>let y = 2;</script>')
            os.utime(index, ns=(1, 1))
            _, h, _ = self.request('GET', '/')
            self.assertIn(base64.b64encode(hashlib.sha256(b'let y = 2;').digest()).decode(), h['content-security-policy'])
        finally:
            index.write_text(old)

    def test_i18n(self):
        self.assertEqual(self.request('GET', '/api/nope', headers={'Accept-Language': 'it-IT,it;q=0.9'})[2],
                         {'error': 'Non trovato.', 'code': 'not_found'})
        self.assertEqual(self.request('GET', '/api/nope', headers={'Accept-Language': 'en-US'})[2],
                         {'error': 'Not found.', 'code': 'not_found'})
        self.assertEqual(self.request('GET', '/api/nope')[2]['error'], 'Not found.')
        d = self.request('POST', '/api/register', {'name': new_name(), 'password': 'x'}, headers={'Accept-Language': 'it'})[2]
        self.assertEqual(d, {'error': 'La password deve avere da 8 a 128 caratteri.', 'code': 'bad_password'})
        d = self.request('POST', '/api/games', game(), headers={'Accept-Language': 'fr'})[2]
        self.assertEqual(d['error'], 'You need to sign in for this.')
        for code, (en, it) in server.MESSAGES.items():                      # every message exists in both languages
            self.assertTrue(en and it, code)

    def test_methods(self):
        self.assertError(self.request('GET', '/api/register'), 405, 'method_not_allowed')
        self.assertEqual(self.request('HEAD', '/api/info')[0], 405)
        self.assertError(self.request('GET', '/api/challenges/x/y'), 404, 'not_found')

    def test_daily_seed(self):
        for day in (date(2026, 11, 10), date(2026, 11, 11), date(2026, 11, 12), date(2027, 1, 1)):
            seed = int.from_bytes(hashlib.sha256(f'overclock-{day.isoformat()}'.encode()).digest()[:4], 'big') & 0x3FFFFFFF
            cpu = 'pipeline' if day < date(2026, 11, 11) else ('gpu', 'mcu', 'singolo', 'multiciclo', 'pipeline')[(day - date(2026, 11, 11)).days % 5]
            self.assertEqual(server.daily_seed(day), seed)
            self.assertEqual(server.daily_cpu(day), cpu)
        self.assertEqual(server.daily_cpu(date(2026, 11, 11)), 'gpu')
        self.assertEqual(server.daily_cpu(date(2026, 11, 16)), 'gpu')
        d = self.request('GET', '/api/daily')[2]
        today = date.today()
        self.assertEqual((d['code'], d['seed'], d['cpu'], d['mode']),
                         (f'D-{today}', server.daily_seed(today), server.daily_cpu(today), 'classica'))

    def test_invite_and_leaderboard(self):
        d = self.request('GET', '/api/invite?sfida=abcde')[2]
        self.assertTrue(d['url'].startswith('http://127.0.0.1:') and d['url'].endswith('/?sfida=ABCDE'))
        self.assertTrue(d['svg'].startswith('<svg'))
        self.assertError(self.request('GET', '/api/invite?sfida=%3Cx%3E'), 400, 'bad_challenge_code')
        self.assertEqual(self.request('GET', '/api/leaderboard?cpu=gpu&mode=sprint&period=week')[2]['period'], 'week')
        self.assertError(self.request('GET', '/api/leaderboard?mode=x'), 400, 'unknown_mode')
        self.assertError(self.request('GET', '/api/players/nobody99'), 404, 'player_not_found')
        self.assertError(self.request('GET', '/api/challenges/QQQQQ'), 404, 'challenge_not_found')

    def test_thread_cap(self):
        self.assertEqual(self.httpd.max_threads, 64)
        self.assertEqual(self.httpd.RequestHandlerClass.timeout, server.REQUEST_TIMEOUT)


class MigrationTests(unittest.TestCase):
    def test_old_database(self):
        tmp = Path(tempfile.mkdtemp(prefix='overclock-test-'))
        try:
            path = tmp / 'old.db'
            con = sqlite3.connect(path)
            con.executescript("""
                CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
                                    salt BLOB NOT NULL, hash BLOB NOT NULL, created TEXT NOT NULL);
                CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), created TEXT NOT NULL);
                CREATE TABLE challenges (code TEXT PRIMARY KEY, mode TEXT NOT NULL, seed INTEGER NOT NULL,
                                         creator INTEGER REFERENCES users(id), created TEXT NOT NULL);
                CREATE TABLE games (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), mode TEXT NOT NULL,
                                    seed INTEGER NOT NULL, challenge TEXT, score INTEGER NOT NULL, time_ms INTEGER NOT NULL,
                                    finished INTEGER NOT NULL, crashed INTEGER NOT NULL, ok INTEGER NOT NULL, perfect INTEGER NOT NULL,
                                    good INTEGER NOT NULL, slow INTEGER NOT NULL, glitches INTEGER NOT NULL, combo INTEGER NOT NULL,
                                    peak REAL NOT NULL, created TEXT NOT NULL);
            """)
            salt = os.urandom(16)
            con.execute('INSERT INTO users VALUES (1, ?, ?, ?, ?, ?)',
                        ('Old', 'old', salt, hashlib.pbkdf2_hmac('sha256', b'oldpw', salt, 200_000), '2026-01-01 10:00:00'))
            con.execute("INSERT INTO sessions VALUES ('t', 1, ?)", (server.now(),))
            con.execute("INSERT INTO games VALUES (1, 1, 'classica', 1, NULL, 100, 60000, 1, 0, 1, 1, 0, 0, 0, 1, 1.0, '2026-01-01 10:01:00')")
            con.commit()
            con.close()
            store = server.Store(path)
            server.Store(path)                                              # twice: nothing to do the second time
            con = store.open()
            cols = {r['name'] for r in con.execute('PRAGMA table_info(games)')}
            self.assertLessEqual({'cpu', 'client_id', 'source'}, cols)
            g = con.execute('SELECT cpu, source, client_id FROM games').fetchone()
            self.assertEqual(tuple(g), ('pipeline', 'live', None))
            self.assertEqual(con.execute('SELECT rounds FROM users').fetchone()[0], 200_000)
            self.assertIsNotNone(con.execute('SELECT last_used FROM sessions').fetchone()[0])
            self.assertIn('games_client', {r['name'] for r in con.execute("PRAGMA index_list(games)")})
            con.close()
            con = store.open()
            row = con.execute('SELECT salt, hash, rounds FROM users').fetchone()
            self.assertEqual(server.pw_hash('oldpw', row['salt'], row['rounds']), row['hash'])
            con.close()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class AdminTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='overclock-test-'))
        self.db = str(self.tmp / 'admin.db')
        self.store = server.Store(Path(self.db))
        con = self.store.open()
        with con:
            for name in ('Alice', 'Bob'):
                salt = os.urandom(16)
                con.execute('INSERT INTO users (name, name_key, salt, hash, rounds, created) VALUES (?, ?, ?, ?, ?, ?)',
                            (name, name.casefold(), salt, server.pw_hash('password1', salt), server.ROUNDS, server.now()))
            con.execute("INSERT INTO sessions (token_hash, user_id, created, last_used) VALUES ('h', 1, ?, ?)", (server.now(), server.now()))
            con.execute("INSERT INTO challenges (code, cpu, mode, seed, creator, created) VALUES ('ABCDE', 'gpu', 'classica', 1, 1, ?)",
                        (server.now(),))
        con.close()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_cli(self, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            server.main([*args, '--db', self.db])
        return out.getvalue()

    def test_users(self):
        self.assertEqual([u['name'] for u in server.admin_users(self.store)], ['Alice', 'Bob'])
        out = self.run_cli('users')
        self.assertIn('Alice', out)
        self.assertIn('2 account(s)', out)

    def test_reset_password(self):
        with self.assertRaises(ValueError):
            server.admin_reset_password(self.store, 'alice', 'short')
        self.assertFalse(server.admin_reset_password(self.store, 'nobody', 'longenough'))
        self.run_cli('reset-password', 'ALICE', '--password', 'brand-new-pw')
        con = self.store.open()
        row = con.execute("SELECT salt, hash, rounds FROM users WHERE name_key = 'alice'").fetchone()
        self.assertEqual(server.pw_hash('brand-new-pw', row['salt'], row['rounds']), row['hash'])
        self.assertEqual(con.execute('SELECT COUNT(*) FROM sessions').fetchone()[0], 0)
        con.close()
        with self.assertRaises(SystemExit):
            self.run_cli('reset-password', 'alice', '--password', 'short')

    def test_import_and_delete(self):
        path = self.tmp / 'export.json'
        games = [game(), game(score=5005)]
        path.write_text(json.dumps(export(games)))
        out = self.run_cli('import', str(path), '--user', 'bob')
        self.assertIn('Imported 1 game(s), 0 already there, 1 rejected.', out)
        self.assertIn('implausible (score_step)', out)
        self.assertIn('Imported 0 game(s), 1 already there', self.run_cli('import', str(path), '--user', 'bob'))
        path.write_text(json.dumps(export(games, hash='f' * 64)))
        with self.assertRaises(SystemExit) as e:
            self.run_cli('import', str(path), '--user', 'bob')
        self.assertIn('checksum', str(e.exception.code))
        with self.assertRaises(LookupError):
            server.admin_import(self.store, 'nobody', path)
        con = self.store.open()
        gid = con.execute('SELECT id FROM games').fetchone()[0]
        con.close()
        self.assertIn(f'Deleted game {gid}', self.run_cli('delete-game', str(gid)))
        with self.assertRaises(SystemExit):
            self.run_cli('delete-game', str(gid))

    def test_delete_user(self):
        self.assertIn('Deleted alice', self.run_cli('delete-user', 'alice'))
        con = self.store.open()
        self.assertEqual(con.execute('SELECT COUNT(*) FROM users').fetchone()[0], 1)
        self.assertIsNone(con.execute("SELECT creator FROM challenges WHERE code = 'ABCDE'").fetchone()[0])
        con.close()
        self.assertFalse(server.admin_delete_user(self.store, 'alice'))

    def test_parser_defaults(self):
        a = server.build_parser().parse_args([])
        self.assertEqual((a.cmd, a.host, a.port, a.qr, a.registration, a.cors_origin), (None, '0.0.0.0', 8765, False, None, []))
        a = server.build_parser().parse_args(['--port', '9000', '--db', 'x.db'])
        self.assertEqual((a.port, a.db), (9000, 'x.db'))
        a = server.build_parser().parse_args(['serve', '--port', '9001', '--cors-origin', 'https://a.example'])
        self.assertEqual((a.cmd, a.port, a.host, a.cors_origin), ('serve', 9001, '0.0.0.0', ['https://a.example']))
        a = server.build_parser().parse_args(['users'])
        self.assertTrue(a.db.endswith('overclock.db'))


@unittest.skipUnless(shutil.which('openssl'), 'needs the openssl command to make a test certificate')
class TlsTests(ServerTest):
    @classmethod
    def setUpClass(cls):
        cls.certdir = Path(tempfile.mkdtemp(prefix='overclock-cert-'))
        cert, key = cls.certdir / 'cert.pem', cls.certdir / 'key.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(key), '-out', str(cert),
                        '-days', '1', '-subj', '/CN=127.0.0.1'], check=True, capture_output=True)
        cls.ssl_context = server.tls_context(cert, key)
        super().setUpClass()

    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        shutil.rmtree(cls.certdir, ignore_errors=True)

    def conn(self):
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return http.client.HTTPSConnection('127.0.0.1', self.port, timeout=10, context=ctx)

    def test_https(self):
        st, _, d = self.request('GET', '/api/info')
        self.assertEqual(st, 200)
        self.assertTrue(self.request('GET', '/api/invite')[2]['url'].startswith('https://'))
        origin = f'https://127.0.0.1:{self.port}'
        self.assertEqual(self.request('GET', '/api/info', headers={'Origin': origin})[1].get('access-control-allow-origin'), origin)

    def test_old_tls_refused(self):
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        try:
            with warnings.catch_warnings():                                 # TLS 1.0/1.1 are deprecated: that's the point
                warnings.simplefilter('ignore', DeprecationWarning)
                ctx.maximum_version = ssl.TLSVersion.TLSv1_1
                ctx.minimum_version = ssl.TLSVersion.TLSv1
        except (ValueError, AttributeError):
            self.skipTest('this OpenSSL cannot even try TLS 1.1')
        c = http.client.HTTPSConnection('127.0.0.1', self.port, timeout=5, context=ctx)
        with self.assertRaises((ssl.SSLError, OSError)):
            c.request('GET', '/api/info')
            c.getresponse()
        c.close()

    def test_plain_http_does_not_hang(self):
        c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        with self.assertRaises((OSError, http.client.HTTPException)):
            c.request('GET', '/api/info')
            c.getresponse().read()
        c.close()
        self.assertEqual(self.request('GET', '/api/info')[0], 200)


class QrTests(unittest.TestCase):
    def test_qr(self):
        url = 'http://192.168.1.28:8765/?sfida=ABCDE'
        svg = qr.svg(url)
        self.assertTrue(svg.startswith('<svg'))
        self.assertEqual(svg, qr.svg(url))
        self.assertIsInstance(qr.terminal(url), str)


if __name__ == '__main__':
    unittest.main()
