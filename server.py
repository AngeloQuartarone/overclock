#!/usr/bin/env python3
"""Overclock: il server per giocare in rete locale.

Serve i file del gioco e una piccola API JSON per account, partite, classifiche e sfide.
Usa solo la libreria standard di Python: non c'è niente da installare. I dati stanno in un file SQLite.

    python3 server.py                          # http://0.0.0.0:8765
    python3 server.py --port 8080 --db altro.db
"""
import argparse
import errno
import hashlib
import hmac
import json
import os
import re
import secrets
import socket
import sqlite3
import sys
import time
import traceback
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

import qr                                                                   # qr.py, qui accanto

ROOT = Path(__file__).resolve().parent
MODES = {'classica': 'score', 'sprint': 'time', 'sopravvivenza': 'score'}   # come si vince: più punti o meno tempo
CPUS = ('singolo', 'multiciclo', 'pipeline', 'mcu', 'gpu')                  # i processori: ognuno ha le sue classifiche
DEFAULT_CPU = 'pipeline'                                                    # le partite di prima erano tutte sulla pipeline
SPRINT_TARGET = 50
# la sfida del giorno cambia processore ogni giorno; prima di questa data era sempre la pipeline
ROTATION_START = date(2026, 11, 11)
ROTATION = ('gpu', 'mcu', 'singolo', 'multiciclo', 'pipeline')
NAME_RE = re.compile(r'^[A-Za-z0-9àèéìòùÀÈÉÌÒÙ-]{3,12}$')
CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'                              # niente 0/O e 1/I: si dettano meglio
CODE_RE = re.compile(r'^[A-Z0-9]{5}$')
DAILY_RE = re.compile(r'^D-(\d{4}-\d{2}-\d{2})$')
JS_RE = re.compile(r'^/js/([a-z0-9_-]+\.js)$')
MAX_BODY = 4096
ROUNDS = 200_000

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  salt BLOB NOT NULL,
  hash BLOB NOT NULL,
  created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS challenges (
  code TEXT PRIMARY KEY,
  cpu TEXT NOT NULL DEFAULT 'pipeline',
  mode TEXT NOT NULL,
  seed INTEGER NOT NULL,
  creator INTEGER REFERENCES users(id),
  created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  cpu TEXT NOT NULL DEFAULT 'pipeline',
  mode TEXT NOT NULL,
  seed INTEGER NOT NULL,
  challenge TEXT,
  score INTEGER NOT NULL,
  time_ms INTEGER NOT NULL,
  finished INTEGER NOT NULL,
  crashed INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  perfect INTEGER NOT NULL,
  good INTEGER NOT NULL,
  slow INTEGER NOT NULL,
  glitches INTEGER NOT NULL,
  combo INTEGER NOT NULL,
  peak REAL NOT NULL,
  created TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS games_mode ON games(mode, created);
CREATE INDEX IF NOT EXISTS games_user ON games(user_id, created);
CREATE INDEX IF NOT EXISTS games_challenge ON games(challenge);
"""


class ApiError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code, self.msg = code, msg


def now():
    return datetime.now().isoformat(sep=' ', timespec='seconds')


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def pw_hash(password, salt):
    return hashlib.pbkdf2_hmac('sha256', password.encode(), salt, ROUNDS)


def daily_seed(day):
    return int.from_bytes(hashlib.sha256(f'overclock-{day}'.encode()).digest()[:4], 'big') & 0x3FFFFFFF


def daily_cpu(day):
    return DEFAULT_CPU if day < ROTATION_START else ROTATION[(day - ROTATION_START).days % len(ROTATION)]


def cpu_of(value, default=DEFAULT_CPU):
    cpu = default if value is None else value
    if cpu not in CPUS:
        raise ApiError(400, 'Processore sconosciuto')
    return cpu


def intval(d, key, hi):
    v = d.get(key)
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or not 0 <= v <= hi:
        raise ApiError(400, f'Valore non valido: {key}')
    return int(v)


class Store:
    def __init__(self, path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        con = self.open()
        try:
            con.execute('PRAGMA journal_mode=WAL')
            con.executescript(SCHEMA)
            for table in ('games', 'challenges'):                          # database di prima dei processori
                cols = {r['name'] for r in con.execute(f'PRAGMA table_info({table})')}
                if 'cpu' not in cols:
                    con.execute(f"ALTER TABLE {table} ADD COLUMN cpu TEXT NOT NULL DEFAULT '{DEFAULT_CPU}'")
            con.execute('CREATE INDEX IF NOT EXISTS games_cpu ON games(cpu, mode, created)')
            con.commit()
        finally:
            con.close()

    def open(self):
        con = sqlite3.connect(self.path, timeout=10)
        con.row_factory = sqlite3.Row
        con.execute('PRAGMA foreign_keys=ON')
        return con


# ---------- classifiche ----------
def board(con, cpu, mode, where='', args=(), limit=1000):
    """Il miglior risultato di ogni giocatore in una modalità di un processore, dal primo all'ultimo."""
    if MODES[mode] == 'score':
        agg, order, cond = 'MAX(g.score)', 'DESC', ''
    else:
        agg, order, cond = 'MIN(g.time_ms)', 'ASC', 'AND g.finished = 1'    # nello sprint conta solo chi arriva in fondo
    rows = con.execute(
        f"""SELECT u.name AS name, {agg} AS best, COUNT(*) AS games
            FROM games g JOIN users u ON u.id = g.user_id
            WHERE g.cpu = ? AND g.mode = ? {cond} {where}
            GROUP BY g.user_id ORDER BY best {order}, u.name_key LIMIT ?""",
        (cpu, mode, *args, limit)).fetchall()
    return [dict(r) for r in rows]


def position(rows, name):
    for i, r in enumerate(rows):
        if r['name'] == name:
            return i + 1
    return None


def best_of(con, cpu, mode, user_id, where='', args=()):
    if MODES[mode] == 'score':
        sql = f'SELECT MAX(score) FROM games WHERE cpu = ? AND mode = ? AND user_id = ? {where}'
    else:
        sql = f'SELECT MIN(time_ms) FROM games WHERE cpu = ? AND mode = ? AND user_id = ? AND finished = 1 {where}'
    return con.execute(sql, (cpu, mode, user_id, *args)).fetchone()[0]


def better(mode, a, b):
    return b is None or (a < b if MODES[mode] == 'time' else a > b)


def find_challenge(con, code):
    code = code.strip().upper()
    m = DAILY_RE.match(code)
    if m:
        try:
            day = date.fromisoformat(m.group(1))
        except ValueError:
            return None
        return {'code': code, 'cpu': daily_cpu(day), 'mode': 'classica', 'seed': daily_seed(day), 'daily': True, 'day': day,
                'creator': None, 'created': day.isoformat()}
    if not CODE_RE.match(code):
        return None
    row = con.execute("""SELECT c.code, c.cpu, c.mode, c.seed, c.created, u.name AS creator
                         FROM challenges c LEFT JOIN users u ON u.id = c.creator WHERE c.code = ?""", (code,)).fetchone()
    return dict(row, daily=False) if row else None


# ---------- HTTP ----------
class Handler(BaseHTTPRequestHandler):
    server_version = 'Overclock/2.0'
    sys_version = ''
    store = None
    host = '0.0.0.0'

    def do_GET(self):
        self.route('GET')

    def do_HEAD(self):
        self.route('HEAD')

    def do_POST(self):
        self.route('POST')

    def log_message(self, fmt, *args):
        sys.stderr.write(f'{self.address_string()} [{self.log_date_time_string()}] {fmt % args}\n')

    def route(self, method):
        url = urlsplit(self.path)
        path = url.path
        try:
            if path.startswith('/api/'):
                if method == 'HEAD':
                    raise ApiError(405, 'Metodo non permesso')
                return self.api(method, path[5:].strip('/'), parse_qs(url.query))
            if method == 'POST':
                raise ApiError(405, 'Metodo non permesso')
            if path == '/overclock' or path.startswith('/overclock/'):     # i vecchi link
                return self.redirect('/' + path[len('/overclock/'):] + (f'?{url.query}' if url.query else ''))
            return self.static(path, method == 'HEAD')
        except ApiError as e:
            self.send_json({'error': e.msg}, e.code)
        except Exception:
            traceback.print_exc()
            self.send_json({'error': 'Errore del server'}, 500)

    # solo i file del gioco: il database e questo script non sono mai raggiungibili da fuori
    def static(self, path, head):
        if path in ('/', '/index.html'):
            name, ctype = 'index.html', 'text/html; charset=utf-8'
        elif JS_RE.match(path):
            name, ctype = 'js/' + JS_RE.match(path).group(1), 'text/javascript; charset=utf-8'
        elif path == '/favicon.ico':
            self.send_response(204)
            self.end_headers()
            return
        else:
            return self.send_plain(404, 'Non trovato')
        file = ROOT / name
        if not file.is_file():
            return self.send_plain(404, 'Non trovato')
        data = file.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        if not head:
            self.wfile.write(data)

    def redirect(self, to):
        self.send_response(301)
        self.send_header('Location', to)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def send_plain(self, code, text):
        data = text.encode()
        self.send_response(code)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            n = -1
        if not 0 <= n <= MAX_BODY:
            self.close_connection = True
            raise ApiError(413, 'Richiesta troppo grande')
        try:
            data = json.loads(self.rfile.read(n) or b'{}')
        except (ValueError, UnicodeDecodeError):
            raise ApiError(400, 'Richiesta non valida')
        if not isinstance(data, dict):
            raise ApiError(400, 'Richiesta non valida')
        return data

    def user(self, con, required=True):
        auth = self.headers.get('Authorization', '')
        token = auth[7:].strip() if auth.startswith('Bearer ') else ''
        row = None
        if token:
            row = con.execute("""SELECT u.id, u.name FROM sessions s JOIN users u ON u.id = s.user_id
                                 WHERE s.token_hash = ?""", (sha(token),)).fetchone()
        if required and not row:
            raise ApiError(401, 'Per questo devi accedere')
        return row

    def api(self, method, route, q):
        parts = [unquote(p) for p in route.split('/')] if route else []
        head, n = (parts[0] if parts else ''), len(parts)
        handlers = {
            ('GET', 'me', 1): self.me,
            ('POST', 'register', 1): self.register,
            ('POST', 'login', 1): self.login,
            ('POST', 'logout', 1): self.logout,
            ('POST', 'games', 1): self.save_game,
            ('GET', 'leaderboard', 1): self.leaderboard,
            ('GET', 'daily', 1): self.daily,
            ('GET', 'challenges', 1): self.my_challenges,
            ('POST', 'challenges', 1): self.create_challenge,
            ('GET', 'challenges', 2): self.challenge,
            ('GET', 'players', 2): self.player,
            ('GET', 'invite', 1): self.invite,
        }
        fn = handlers.get((method, head, n))
        if not fn:
            raise ApiError(404, 'Non trovato')
        con = self.store.open()
        try:
            with con:                                                       # commit se va tutto bene, altrimenti annulla
                out = fn(con, q=q, arg=parts[1] if n > 1 else None)
        finally:
            con.close()
        self.send_json(out)

    # ---------- account ----------
    def me(self, con, **_):
        u = self.user(con, required=False)
        return {'user': {'name': u['name']} if u else None, 'cpus': list(CPUS)}

    def new_session(self, con, user_id):
        token = secrets.token_urlsafe(32)
        con.execute('INSERT INTO sessions (token_hash, user_id, created) VALUES (?, ?, ?)', (sha(token), user_id, now()))
        return token

    def credentials(self):
        d = self.body()
        name, password = str(d.get('name', '')).strip(), d.get('password', '')
        if not isinstance(password, str):
            raise ApiError(400, 'Password non valida')
        return name, password

    def register(self, con, **_):
        name, password = self.credentials()
        if not NAME_RE.match(name):
            raise ApiError(400, 'Il nome deve avere da 3 a 12 caratteri: lettere, cifre o trattino.')
        if not 4 <= len(password) <= 64:
            raise ApiError(400, 'La password deve avere da 4 a 64 caratteri.')
        salt = os.urandom(16)
        try:
            cur = con.execute('INSERT INTO users (name, name_key, salt, hash, created) VALUES (?, ?, ?, ?, ?)',
                              (name, name.casefold(), salt, pw_hash(password, salt), now()))
        except sqlite3.IntegrityError:
            raise ApiError(409, 'Questo nome è già preso.')
        return {'token': self.new_session(con, cur.lastrowid), 'user': {'name': name}}

    def login(self, con, **_):
        name, password = self.credentials()
        row = con.execute('SELECT id, name, salt, hash FROM users WHERE name_key = ?', (name.casefold(),)).fetchone()
        if not row or not hmac.compare_digest(pw_hash(password, row['salt']), row['hash']):
            time.sleep(0.4)                                                  # un freno per chi prova a indovinare
            raise ApiError(401, 'Nome o password sbagliati.')
        return {'token': self.new_session(con, row['id']), 'user': {'name': row['name']}}

    def logout(self, con, **_):
        auth = self.headers.get('Authorization', '')
        if auth.startswith('Bearer '):
            con.execute('DELETE FROM sessions WHERE token_hash = ?', (sha(auth[7:].strip()),))
        return {'ok': True}

    # ---------- partite ----------
    def save_game(self, con, **_):
        u = self.user(con)
        d = self.body()
        mode = d.get('mode')
        if mode not in MODES:
            raise ApiError(400, 'Modalità sconosciuta')
        cpu = cpu_of(d.get('cpu'))
        seed = intval(d, 'seed', 2**31 - 1)
        v = {k: intval(d, k, hi) for k, hi in (('score', 10**7), ('time_ms', 86_400_000), ('ok', 10**5),
                                               ('perfect', 10**5), ('good', 10**5), ('slow', 10**5),
                                               ('glitches', 10**5), ('combo', 10**5))}
        peak = d.get('peak')
        if isinstance(peak, bool) or not isinstance(peak, (int, float)) or not 0 <= peak <= 1000:
            raise ApiError(400, 'Valore non valido: peak')
        crashed = bool(d.get('crashed'))
        finished = bool(d.get('finished')) and not crashed
        if mode == 'sprint':
            finished = finished and v['ok'] >= SPRINT_TARGET
        code = d.get('challenge')
        ch = None
        if code is not None:
            ch = find_challenge(con, str(code))
            if not ch or ch['cpu'] != cpu or ch['mode'] != mode or ch['seed'] != seed:
                raise ApiError(400, 'La partita non corrisponde alla sfida.')
            if ch['daily'] and ch['day'] != date.today():
                raise ApiError(400, 'Quella sfida del giorno è chiusa.')
        prev = best_of(con, cpu, mode, u['id'])
        cur = con.execute(
            """INSERT INTO games (user_id, cpu, mode, seed, challenge, score, time_ms, finished, crashed, ok, perfect, good,
                                  slow, glitches, combo, peak, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (u['id'], cpu, mode, seed, ch['code'] if ch else None, v['score'], v['time_ms'], int(finished), int(crashed),
             v['ok'], v['perfect'], v['good'], v['slow'], v['glitches'], v['combo'], round(float(peak), 2), now()))
        value = v['score'] if MODES[mode] == 'score' else (v['time_ms'] if finished else None)
        rows = board(con, cpu, mode)
        out = {'id': cur.lastrowid, 'cpu': cpu, 'value': value, 'best': value is not None and better(mode, value, prev),
               'record': best_of(con, cpu, mode, u['id']), 'rank': position(rows, u['name']), 'total': len(rows),
               'challenge': None}
        if ch:
            crow = board(con, cpu, mode, 'AND g.challenge = ?', (ch['code'],))
            out['challenge'] = {'code': ch['code'], 'daily': ch['daily'], 'rank': position(crow, u['name']), 'total': len(crow)}
        return out

    def leaderboard(self, con, q, **_):
        mode = (q.get('mode') or ['classica'])[0]
        if mode not in MODES:
            raise ApiError(400, 'Modalità sconosciuta')
        cpu = cpu_of((q.get('cpu') or [None])[0])
        period = (q.get('period') or ['all'])[0]
        if period == 'week':
            since = (datetime.now() - timedelta(days=7)).isoformat(sep=' ', timespec='seconds')
            rows = board(con, cpu, mode, 'AND g.created >= ?', (since,), limit=50)
        else:
            period, rows = 'all', board(con, cpu, mode, limit=50)
        return {'cpu': cpu, 'mode': mode, 'period': period, 'rows': rows}

    # link da far inquadrare: l'indirizzo di rete del server (anche se chi chiede è su localhost), con la sfida se c'è
    def invite(self, con, q, **_):
        url = public_url(self.host, self.server.server_address[1])
        code = (q.get('sfida') or [''])[0].strip().upper()
        if code:
            if not (CODE_RE.match(code) or DAILY_RE.match(code)):
                raise ApiError(400, 'Codice della sfida non valido')
            url += f'?sfida={code}'
        return {'url': url, 'svg': qr.svg(url)}

    # ---------- sfide ----------
    def daily(self, con, **_):
        ch = find_challenge(con, f'D-{date.today().isoformat()}')
        return {'code': ch['code'], 'cpu': ch['cpu'], 'mode': ch['mode'], 'seed': ch['seed'], 'date': ch['created'],
                'standings': board(con, ch['cpu'], ch['mode'], 'AND g.challenge = ?', (ch['code'],), limit=50)}

    def challenge(self, con, arg, **_):
        ch = find_challenge(con, arg or '')
        if not ch:
            raise ApiError(404, 'Questa sfida non esiste: controlla il codice.')
        return {'code': ch['code'], 'cpu': ch['cpu'], 'mode': ch['mode'], 'seed': ch['seed'], 'daily': ch['daily'],
                'creator': ch['creator'], 'created': ch['created'],
                'standings': board(con, ch['cpu'], ch['mode'], 'AND g.challenge = ?', (ch['code'],), limit=50)}

    def create_challenge(self, con, **_):
        u = self.user(con)
        d = self.body()
        mode = d.get('mode')
        if mode not in MODES:
            raise ApiError(400, 'Modalità sconosciuta')
        cpu = cpu_of(d.get('cpu'))
        seed = intval(d, 'seed', 2**31 - 1) if 'seed' in d else secrets.randbelow(1 << 30)
        for _ in range(20):
            code = ''.join(secrets.choice(CODE_CHARS) for _ in range(5))
            try:
                con.execute('INSERT INTO challenges (code, cpu, mode, seed, creator, created) VALUES (?, ?, ?, ?, ?, ?)',
                            (code, cpu, mode, seed, u['id'], now()))
                break
            except sqlite3.IntegrityError:
                continue
        else:
            raise ApiError(500, 'Non riesco a creare un codice, riprova.')
        if 'game' in d:                                                     # la partita appena fatta vale già per la sfida
            con.execute("""UPDATE games SET challenge = ? WHERE id = ? AND user_id = ? AND cpu = ? AND mode = ? AND seed = ?
                           AND challenge IS NULL""", (code, intval(d, 'game', 2**62), u['id'], cpu, mode, seed))
        return {'code': code, 'cpu': cpu, 'mode': mode, 'seed': seed}

    def my_challenges(self, con, **_):
        u = self.user(con)
        rows = con.execute(
            """SELECT c.code, c.cpu, c.mode, c.created, cu.name AS creator FROM challenges c
               LEFT JOIN users cu ON cu.id = c.creator
               WHERE c.creator = ? OR c.code IN (SELECT challenge FROM games WHERE user_id = ? AND challenge IS NOT NULL)
               ORDER BY c.created DESC LIMIT 20""", (u['id'], u['id'])).fetchall()
        out = []
        for r in rows:
            st = board(con, r['cpu'], r['mode'], 'AND g.challenge = ?', (r['code'],))
            out.append({'code': r['code'], 'cpu': r['cpu'], 'mode': r['mode'], 'creator': r['creator'], 'created': r['created'],
                        'players': len(st), 'leader': st[0] if st else None, 'rank': position(st, u['name'])})
        return {'challenges': out}

    # ---------- profilo ----------
    def player(self, con, arg, **_):
        row = con.execute('SELECT id, name, created FROM users WHERE name_key = ?', ((arg or '').casefold(),)).fetchone()
        if not row:
            raise ApiError(404, 'Giocatore non trovato')
        t = con.execute("""SELECT COUNT(*) AS games, COALESCE(SUM(time_ms), 0) AS time_ms, COALESCE(SUM(ok), 0) AS ok,
                                  COALESCE(SUM(perfect), 0) AS perfect, COALESCE(SUM(good), 0) AS good,
                                  COALESCE(SUM(slow), 0) AS slow, COALESCE(SUM(glitches), 0) AS glitches,
                                  COALESCE(MAX(combo), 0) AS combo, COALESCE(MAX(peak), 0) AS peak
                           FROM games WHERE user_id = ?""", (row['id'],)).fetchone()
        # per ogni processore: record, posizione e picco di frequenza (ognuno con la sua unità)
        cpus = {}
        for c, games, peak in con.execute("""SELECT cpu, COUNT(*), MAX(peak) FROM games WHERE user_id = ?
                                             GROUP BY cpu""", (row['id'],)).fetchall():
            if c not in CPUS:
                continue
            modes = {}
            for m in MODES:
                n = con.execute('SELECT COUNT(*) FROM games WHERE user_id = ? AND cpu = ? AND mode = ?', (row['id'], c, m)).fetchone()[0]
                rows = board(con, c, m)
                modes[m] = {'games': n, 'best': best_of(con, c, m, row['id']), 'rank': position(rows, row['name']), 'total': len(rows)}
            cpus[c] = {'games': games, 'peak': peak or 0, 'modes': modes}
        recent = con.execute("""SELECT cpu, mode, score, time_ms, finished, crashed, challenge, created FROM games
                                WHERE user_id = ? ORDER BY id DESC LIMIT 10""", (row['id'],)).fetchall()
        return {'name': row['name'], 'since': row['created'], 'totals': dict(t), 'cpus': cpus,
                'modes': cpus.get(DEFAULT_CPU, {}).get('modes') or {m: {'games': 0, 'best': None, 'rank': None, 'total': 0} for m in MODES},
                'recent': [dict(r) for r in recent]}


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.254.254.254', 1))                                    # non parte nessun pacchetto: serve solo a scegliere l'interfaccia
        return s.getsockname()[0]
    except OSError:
        return '127.0.0.1'
    finally:
        s.close()


def public_url(host, port):
    """L'indirizzo con cui gli altri dispositivi della rete raggiungono il server."""
    return f'http://{lan_ip() if host in ("0.0.0.0", "") else host}:{port}/'


def print_qr(url):
    print(qr.terminal(url))
    print(f'  inquadralo con la fotocamera del telefono per aprire {url}')


def main():
    p = argparse.ArgumentParser(description='Server di Overclock per la rete locale')
    p.add_argument('--host', default='0.0.0.0', help='interfaccia (0.0.0.0 = tutte, 127.0.0.1 = solo questo computer)')
    p.add_argument('--port', type=int, default=8765)
    p.add_argument('--db', default=str(ROOT / 'data' / 'overclock.db'), help='file SQLite con account e partite')
    p.add_argument('--qr', action='store_true', help='stampa solo il QR code con l\'indirizzo del gioco ed esce (utile se il server gira già)')
    a = p.parse_args()
    url = public_url(a.host, a.port)
    if a.qr:
        return print_qr(url)
    Handler.store = Store(Path(a.db).expanduser().resolve())
    Handler.host = a.host
    try:
        httpd = ThreadingHTTPServer((a.host, a.port), Handler)
    except OSError as e:
        if e.errno not in (errno.EADDRINUSE, errno.EADDRNOTAVAIL):
            raise
        if e.errno == errno.EADDRNOTAVAIL:
            sys.exit(f'Questo computer non ha l\'indirizzo {a.host}: prova senza --host.')
        sys.exit(f'La porta {a.port} è già occupata: probabilmente Overclock è già acceso (anche in background).\n'
                 f'  per spegnerlo:      kill $(lsof -tiTCP:{a.port} -sTCP:LISTEN)\n'
                 f'  per vedere il QR:   python3 server.py --qr{"" if a.port == 8765 else f" --port {a.port}"}\n'
                 f'  o usa un\'altra porta: python3 server.py --port {a.port + 1}')
    httpd.daemon_threads = True
    print(f'Overclock in ascolto su {a.host}:{a.port}')
    print(f'  da questo computer: http://localhost:{a.port}/')
    if a.host in ('0.0.0.0', ''):
        print(f'  dagli altri PC:     {url}')
    print(f'  dati: {Handler.store.path}   (Ctrl+C per fermare)')
    if not a.host.startswith('127.'):
        print()
        print_qr(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\nFermato.')


if __name__ == '__main__':
    main()
