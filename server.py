#!/usr/bin/env python3
"""Overclock: the server for playing on a local network.

Serves the game files and a small JSON API for accounts, games, leaderboards and challenges.
Python standard library only: nothing to install. The data lives in one SQLite file.

    python3 server.py                               # http://0.0.0.0:8765
    python3 server.py --port 8080 --db other.db
    python3 server.py --cert cert.pem --key key.pem # https
    python3 server.py users                         # admin commands: see --help
"""
import argparse
import base64
import errno
import getpass
import hashlib
import hmac
import json
import math
import os
import re
import secrets
import socket
import sqlite3
import ssl
import sys
import threading
import time
import traceback
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

import qr                                                                   # qr.py, next to this file

ROOT = Path(__file__).resolve().parent
API_VERSION = 2
MODES = {'classica': 'score', 'sprint': 'time', 'sopravvivenza': 'score'}   # how you win: more points or less time
CPUS = ('singolo', 'multiciclo', 'pipeline', 'mcu', 'gpu')                  # the processors: each has its own leaderboards
DEFAULT_CPU = 'pipeline'                                                    # games from before the processors were all pipeline
SPRINT_TARGET = 50
# the daily challenge changes processor every day; before this date it was always the pipeline
ROTATION_START = date(2026, 11, 11)
ROTATION = ('gpu', 'mcu', 'singolo', 'multiciclo', 'pipeline')
# peak frequency: freq.k of each js/proc-*.js; the client clamps the period to >= 0.05 s, so peak <= 20 * k
PEAK_K = {'singolo': 2, 'multiciclo': 30, 'pipeline': 1.6, 'mcu': 4.8, 'gpu': 0.9}
NAME_RE = re.compile(r'^[A-Za-z0-9àèéìòùÀÈÉÌÒÙ-]{3,12}$')
CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'                              # no 0/O or 1/I: easier to read out loud
CODE_RE = re.compile(r'^[A-Z0-9]{5}$')
DAILY_RE = re.compile(r'^D-(\d{4}-\d{2}-\d{2})$')
GAME_ID_RE = re.compile(r'^[A-Za-z0-9_-]{8,40}$')
PLAYED_RE = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3}|\.\d{6})?(Z|\+00:00)$')
PASSWORD_MIN, PASSWORD_MAX = 8, 128                                         # new accounts; old 4+ passwords still log in
MAX_BODY = 4096
MAX_IMPORT_BODY = 2 * 1024 * 1024
MAX_IMPORT_GAMES = 2000
EXPORT_FORMAT, EXPORT_VERSION, HASH_PREFIX = 'overclock-results', 1, 'overclock-results-v1\n'
ROUNDS = 600_000                                                            # PBKDF2-SHA256; each user keeps its own count
LEGACY_ROUNDS = 200_000                                                     # accounts created before the 'rounds' column
SESSION_DAYS = 90                                                           # a token expires after 90 days without use
REQUEST_TIMEOUT = 15                                                        # seconds of silence before a socket is dropped
MAX_THREADS = 64                                                            # requests served at the same time
PUBLIC_ORIGINS = ('https://angeloquartarone.github.io',)                    # the public site may call this API (CORS)
# rate limits: kind -> (burst, seconds to refill the whole burst). auth = login + register per IP, the rest per user
LIMITS = {'auth': (10, 60), 'games': (5, 10), 'import': (10, 3600), 'challenge': (30, 3600)}
LOCKOUT = (5, 60)                                                           # 5 wrong passwords for a name -> 60 s pause
DUMMY_SALT = os.urandom(16)                                                 # unknown users still cost one PBKDF2

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  salt BLOB NOT NULL,
  hash BLOB NOT NULL,
  rounds INTEGER NOT NULL DEFAULT 200000,
  created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created TEXT NOT NULL,
  last_used TEXT
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
  created TEXT NOT NULL,
  client_id TEXT,
  source TEXT NOT NULL DEFAULT 'live'
);
CREATE INDEX IF NOT EXISTS games_mode ON games(mode, created);
CREATE INDEX IF NOT EXISTS games_user ON games(user_id, created);
CREATE INDEX IF NOT EXISTS games_challenge ON games(challenge);
"""

# ---------- errors, in English and Italian ----------
MESSAGES = {
    'not_found': ('Not found.', 'Non trovato.'),
    'method_not_allowed': ('Method not allowed.', 'Metodo non permesso.'),
    'bad_request': ('Invalid request.', 'Richiesta non valida.'),
    'body_too_large': ('Request too large.', 'Richiesta troppo grande.'),
    'bad_content_type': ('The request body must be application/json.', 'Il corpo della richiesta deve essere application/json.'),
    'origin_not_allowed': ('This site is not allowed to use the API.', "Questo sito non può usare l'API."),
    'auth_required': ('You need to sign in for this.', 'Per questo devi accedere.'),
    'bad_credentials': ('Wrong name or password.', 'Nome o password sbagliati.'),
    'bad_name': ('The name must be 3 to 12 characters: letters, digits or hyphen.',
                 'Il nome deve avere da 3 a 12 caratteri: lettere, cifre o trattino.'),
    'bad_password': (f'The password must be {PASSWORD_MIN} to {PASSWORD_MAX} characters.',
                     f'La password deve avere da {PASSWORD_MIN} a {PASSWORD_MAX} caratteri.'),
    'name_taken': ('This name is already taken.', 'Questo nome è già preso.'),
    'registration_closed': ('Registration is closed on this server.', 'Su questo server le iscrizioni sono chiuse.'),
    'bad_invite': ('A valid invite code is required to register.', 'Per iscriverti serve un codice di invito valido.'),
    'rate_limited': ('Too many requests: wait a moment and try again.', 'Troppe richieste: aspetta un momento e riprova.'),
    'locked': ('Too many wrong passwords for this name: try again in a minute.',
               'Troppe password sbagliate per questo nome: riprova tra un minuto.'),
    'unknown_mode': ('Unknown mode.', 'Modalità sconosciuta.'),
    'unknown_cpu': ('Unknown processor.', 'Processore sconosciuto.'),
    'bad_value': ('Invalid value: {field}.', 'Valore non valido: {field}.'),
    'bad_id': ('Invalid game id.', 'Id della partita non valido.'),
    'bad_played': ('Invalid game date.', 'Data della partita non valida.'),
    'implausible': ('These results are not possible in the game ({rule}).', 'Questi risultati non sono possibili nel gioco ({rule}).'),
    'challenge_mismatch': ('The game does not match the challenge.', 'La partita non corrisponde alla sfida.'),
    'challenge_closed': ('That daily challenge is closed.', 'Quella sfida del giorno è chiusa.'),
    'bad_challenge_code': ('Invalid challenge code.', 'Codice della sfida non valido.'),
    'challenge_not_found': ('This challenge does not exist: check the code.', 'Questa sfida non esiste: controlla il codice.'),
    'player_not_found': ('Player not found.', 'Giocatore non trovato.'),
    'code_failed': ('Could not create a code, try again.', 'Non riesco a creare un codice, riprova.'),
    'bad_format': ('This is not an Overclock results file.', 'Questo non è un file di risultati di Overclock.'),
    'bad_version': ('This results file version is not supported.', 'Questa versione del file di risultati non è supportata.'),
    'bad_hash': ('The file was modified or is damaged (checksum mismatch).', 'Il file è stato modificato o è rovinato (il controllo non torna).'),
    'too_many_games': ('Too many games in one file (max {max}).', 'Troppe partite in un file (al massimo {max}).'),
    'server_error': ('Server error.', 'Errore del server.'),
}


class ApiError(Exception):
    """An error for the client: HTTP status, a stable snake_case code and optional fields (field, rule, max, retry_after)."""
    def __init__(self, status, code, **params):
        super().__init__(code)
        self.status, self.code, self.params = status, code, params

    def message(self, lang='en'):
        en, it = MESSAGES.get(self.code, MESSAGES['server_error'])
        return (it if lang == 'it' else en).format(**self.params)


def now():
    return datetime.now().isoformat(sep=' ', timespec='seconds')


def ago(**kw):
    return (datetime.now() - timedelta(**kw)).isoformat(sep=' ', timespec='seconds')


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def pw_hash(password, salt, rounds=None):
    return hashlib.pbkdf2_hmac('sha256', password.encode(), salt, rounds or ROUNDS)


def daily_seed(day):
    return int.from_bytes(hashlib.sha256(f'overclock-{day}'.encode()).digest()[:4], 'big') & 0x3FFFFFFF


def daily_cpu(day):
    return DEFAULT_CPU if day < ROTATION_START else ROTATION[(day - ROTATION_START).days % len(ROTATION)]


def strict_json(txt):
    """json.loads without NaN/Infinity (they are not JSON)."""
    def reject(c):
        raise ValueError(c)
    return json.loads(txt, parse_constant=reject)


def is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def intval(d, key, hi):
    """A JSON integer in 0..hi (no floats, no booleans)."""
    v = d.get(key)
    if not is_int(v) or not 0 <= v <= hi:
        raise ApiError(400, 'bad_value', field=key)
    return v


def text(d, key):
    v = d.get(key, '')
    if not isinstance(v, str):
        raise ApiError(400, 'bad_value', field=key)
    return v


def mode_of(value):
    if not isinstance(value, str) or value not in MODES:
        raise ApiError(400, 'unknown_mode')
    return value


def cpu_of(value, default=DEFAULT_CPU):
    cpu = default if value is None else value
    if not isinstance(cpu, str) or cpu not in CPUS:
        raise ApiError(400, 'unknown_cpu')
    return cpu


def parse_played(value):
    """ISO-8601 UTC ('2026-11-10T21:39:12.000Z') -> aware datetime; at most 1 day in the future."""
    if not isinstance(value, str) or not PLAYED_RE.match(value):
        raise ApiError(400, 'bad_played')
    try:
        dt = datetime.fromisoformat(value[:-1] + '+00:00' if value.endswith('Z') else value)
    except ValueError:
        raise ApiError(400, 'bad_played')
    if dt > datetime.now(timezone.utc) + timedelta(days=1):
        raise ApiError(400, 'bad_played')
    return dt


def local_time(dt):
    """Aware datetime -> the local 'YYYY-MM-DD HH:MM:SS' used in the database."""
    return dt.astimezone().replace(tzinfo=None).isoformat(sep=' ', timespec='seconds')


# ---------- export hash (same algorithm as the client, see CONTRACT: line(g) joined by \n) ----------
def js_str(v):
    """How JavaScript's Array.join turns a value into text."""
    if v is None:
        return ''
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        if v != v:
            return 'NaN'
        return str(int(v)) if v.is_integer() and abs(v) < 1e21 else repr(v)
    return v if isinstance(v, str) else json.dumps(v)


def js_truthy(v):
    return not (v is None or v is False or v == 0 or v == '' or (isinstance(v, float) and v != v))


def js_round(x):
    """Math.round: halves go up (Python's round() goes to even)."""
    r = math.floor(x)
    return r + 1 if x - r >= 0.5 else r


def game_line(g):
    peak = g.get('peak')
    peak10 = js_round(peak * 10) if is_int(peak) or (isinstance(peak, float) and math.isfinite(peak)) else 'NaN'
    return '|'.join([js_str(g.get('id')), js_str(g.get('played')), js_str(g.get('cpu')), js_str(g.get('mode')),
                     js_str(g.get('seed')), js_str(g.get('challenge')) if js_truthy(g.get('challenge')) else '',
                     *(js_str(g.get(k)) for k in ('score', 'time_ms')),
                     '1' if js_truthy(g.get('finished')) else '0', '1' if js_truthy(g.get('crashed')) else '0',
                     *(js_str(g.get(k)) for k in ('ok', 'perfect', 'good', 'slow', 'glitches', 'combo')), js_str(peak10)])


def export_hash(games):
    return hashlib.sha256((HASH_PREFIX + '\n'.join(game_line(g) for g in games)).encode()).hexdigest()


# ---------- rate limits ----------
class RateLimiter:
    """Token buckets in memory: up to `burst` requests at once, refilled over `period` seconds.
    Plus a short lockout per account name after repeated wrong passwords."""
    def __init__(self, limits=None, lockout=LOCKOUT, clock=time.monotonic):
        self.limits = dict(LIMITS, **(limits or {}))
        self.lockout, self.clock = lockout, clock
        self.lock = threading.Lock()
        self.buckets = {}                                                   # (kind, key) -> (tokens, when)
        self.fails = {}                                                     # name -> [failures, locked until, last failure]

    def hit(self, kind, key):
        """Takes a token: 0 if allowed, otherwise the seconds to wait."""
        burst, period = self.limits[kind]
        rate, t = burst / period, self.clock()
        with self.lock:
            if len(self.buckets) > 20000:                                   # forget the buckets that are full again
                self.buckets = {k: v for k, v in self.buckets.items() if t - v[1] < self.limits[k[0]][1]}
            tokens, last = self.buckets.get((kind, key), (burst, t))
            tokens = min(burst, tokens + (t - last) * rate)
            if tokens < 1:
                self.buckets[(kind, key)] = (tokens, t)
                return max(1, math.ceil((1 - tokens) / rate))
            self.buckets[(kind, key)] = (tokens - 1, t)
            return 0

    def locked(self, name):
        with self.lock:
            f = self.fails.get(name)
            return max(0, math.ceil(f[1] - self.clock())) if f else 0

    def failed(self, name):
        n, seconds = self.lockout
        t = self.clock()
        with self.lock:
            if len(self.fails) > 20000:
                self.fails = {k: v for k, v in self.fails.items() if t - v[2] < 900 or v[1] > t}
            f = self.fails.get(name)
            if not f or t - f[2] > 900:                                     # failures older than 15 minutes don't count
                f = self.fails[name] = [0, 0, t]
            f[0] += 1
            f[2] = t
            if f[0] >= n:
                f[0], f[1] = 0, t + seconds

    def succeeded(self, name):
        with self.lock:
            self.fails.pop(name, None)


# ---------- database ----------
class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        con = self.open()
        try:
            con.execute('PRAGMA journal_mode=WAL')
            con.executescript(SCHEMA)
            # databases from older versions: add the missing columns
            for table in ('games', 'challenges'):
                self.add_column(con, table, 'cpu', f"TEXT NOT NULL DEFAULT '{DEFAULT_CPU}'")
            self.add_column(con, 'users', 'rounds', f'INTEGER NOT NULL DEFAULT {LEGACY_ROUNDS}')
            if self.add_column(con, 'sessions', 'last_used', 'TEXT'):
                con.execute('UPDATE sessions SET last_used = created WHERE last_used IS NULL')
            self.add_column(con, 'games', 'client_id', 'TEXT')
            self.add_column(con, 'games', 'source', "TEXT NOT NULL DEFAULT 'live'")
            con.execute('CREATE INDEX IF NOT EXISTS games_cpu ON games(cpu, mode, created)')
            con.execute('CREATE UNIQUE INDEX IF NOT EXISTS games_client ON games(user_id, client_id) WHERE client_id IS NOT NULL')
            con.commit()
        finally:
            con.close()

    @staticmethod
    def add_column(con, table, column, decl):
        cols = {r['name'] for r in con.execute(f'PRAGMA table_info({table})')}
        if column in cols:
            return False
        con.execute(f'ALTER TABLE {table} ADD COLUMN {column} {decl}')
        return True

    def open(self):
        con = sqlite3.connect(self.path, timeout=10)
        con.row_factory = sqlite3.Row
        con.execute('PRAGMA foreign_keys=ON')
        return con

    def cleanup(self):
        """Removes the expired sessions; returns how many."""
        con = self.open()
        try:
            with con:
                return con.execute('DELETE FROM sessions WHERE COALESCE(last_used, created) < ?',
                                   (ago(days=SESSION_DAYS),)).rowcount
        finally:
            con.close()


# ---------- leaderboards ----------
def board(con, cpu, mode, where='', args=(), limit=1000):
    """Each player's best result in one mode of one processor, from first to last."""
    if MODES[mode] == 'score':
        agg, order, cond = 'MAX(g.score)', 'DESC', ''
    else:
        agg, order, cond = 'MIN(g.time_ms)', 'ASC', 'AND g.finished = 1'    # in the sprint only finished games count
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


# ---------- one game: types, plausibility, challenge (live saves and imports) ----------
def plausible(cpu, mode, v, finished, crashed, peak):
    """Rules derived from js/main.js clockEdge(); returns the name of the broken rule, or None."""
    pg = v['perfect'] + v['good']
    hits = pg + v['slow']
    rules = (
        ('finished_crashed', finished and crashed),
        ('score_step', v['score'] % 10 != 0),                               # every point value is a multiple of 10
        ('combo', v['combo'] > pg),
        # 100/50/10 per hit x4 at most, plus bonuses: GPU 300 x4 per frame (32 edges), MCU 150 x4 per IRQ
        # (5 edges, but only 4 when interrupts are tail-chained: 600 / 4 = 150 per hit)
        ('score', v['score'] > 400 * pg + 40 * v['slow'] + 150 * hits + 1200),
        ('speed', hits * 50 > v['time_ms'] + 1000),                         # a cycle takes at least 50 ms everywhere
        ('glitches', v['glitches'] > (3 if crashed else 2) + pg // 20),     # 3 lives, +1 every 20 combo
        ('ok', v['ok'] > hits + v['glitches'] + 3 + hits // 20 + 5),
        ('time', mode == 'classica' and v['time_ms'] > 61000),
        ('sprint', mode == 'sprint' and (v['ok'] > SPRINT_TARGET or (finished and v['ok'] != SPRINT_TARGET))),
        ('peak', peak > 20 * PEAK_K[cpu] + 0.05),
    )
    for rule, broken in rules:
        if broken:
            return rule
    return None


def check_game(con, d, live, today=None):
    """Validates one game; returns the row to insert. Raises ApiError (the code goes in the import's rejected list).
    live: a save at the end of a game (id/played optional, a daily challenge only today);
    otherwise an import (id/played required, a daily challenge within 1 day of 'played', foreign codes dropped)."""
    if not isinstance(d, dict):
        raise ApiError(400, 'bad_request')
    gid = d.get('id')
    if not (gid is None and live) and (not isinstance(gid, str) or not GAME_ID_RE.match(gid)):
        raise ApiError(400, 'bad_id')
    played = datetime.now(timezone.utc) if d.get('played') is None and live else parse_played(d.get('played'))
    mode = mode_of(d.get('mode'))
    cpu = cpu_of(d.get('cpu'))
    seed = intval(d, 'seed', 2**31 - 1)
    v = {k: intval(d, k, hi) for k, hi in (('score', 10**7), ('time_ms', 86_400_000), ('ok', 10**5),
                                           ('perfect', 10**5), ('good', 10**5), ('slow', 10**5),
                                           ('glitches', 10**5), ('combo', 10**5))}
    for k in ('finished', 'crashed'):
        if not isinstance(d.get(k), bool):
            raise ApiError(400, 'bad_value', field=k)
    finished, crashed = d['finished'], d['crashed']
    peak = d.get('peak')
    if isinstance(peak, bool) or not isinstance(peak, (int, float)) or not math.isfinite(peak) or not 0 <= peak <= 1000:
        raise ApiError(400, 'bad_value', field='peak')
    rule = plausible(cpu, mode, v, finished, crashed, peak)
    if rule:
        raise ApiError(400, 'implausible', rule=rule)
    code, ch = d.get('challenge'), None
    if code is not None:
        if not isinstance(code, str):
            raise ApiError(400, 'bad_value', field='challenge')
        ch = find_challenge(con, code)
        daily = bool(DAILY_RE.match(code.strip().upper()))
        if not ch or ch['cpu'] != cpu or ch['mode'] != mode or ch['seed'] != seed:
            if live or daily:
                raise ApiError(400, 'challenge_mismatch')
            ch = None                                                       # a challenge of another server: keep the game, drop the link
        elif ch['daily']:
            if live and ch['day'] != (today or date.today()):
                raise ApiError(400, 'challenge_closed')
            if not live and abs((ch['day'] - played.date()).days) > 1:
                raise ApiError(400, 'challenge_closed')
    return dict(client_id=gid, cpu=cpu, mode=mode, seed=seed, challenge=ch['code'] if ch else None, **v,
                finished=int(finished), crashed=int(crashed), peak=round(float(peak), 2), created=local_time(played))


GAME_COLS = ('user_id', 'cpu', 'mode', 'seed', 'challenge', 'score', 'time_ms', 'finished', 'crashed', 'ok', 'perfect', 'good',
             'slow', 'glitches', 'combo', 'peak', 'created', 'client_id', 'source')


def insert_game(con, user_id, g, source):
    """Returns the new row id, or None if this user already has a game with that client id."""
    row = dict(g, user_id=user_id, source=source)
    try:
        cur = con.execute(f'INSERT INTO games ({", ".join(GAME_COLS)}) VALUES ({", ".join("?" * len(GAME_COLS))})',
                          [row[c] for c in GAME_COLS])
    except sqlite3.IntegrityError:
        return None
    return cur.lastrowid


def import_results(con, user_id, doc):
    """Imports an exported results file for one user (POST /api/import and `server.py import`)."""
    if not isinstance(doc, dict) or doc.get('format') != EXPORT_FORMAT:
        raise ApiError(400, 'bad_format')
    if not is_int(doc.get('version')) or doc['version'] != EXPORT_VERSION:
        raise ApiError(400, 'bad_version')
    games, digest = doc.get('games'), doc.get('hash')
    if not isinstance(games, list) or not isinstance(digest, str) or not all(isinstance(g, dict) for g in games):
        raise ApiError(400, 'bad_format')
    if len(games) > MAX_IMPORT_GAMES:
        raise ApiError(400, 'too_many_games', max=MAX_IMPORT_GAMES)
    if not hmac.compare_digest(export_hash(games).encode(), digest.strip().lower().encode('ascii', 'replace')):
        raise ApiError(400, 'bad_hash')
    out = {'imported': 0, 'duplicates': 0, 'rejected': []}
    today = date.today()
    for i, d in enumerate(games):
        try:
            g = check_game(con, d, live=False, today=today)
        except ApiError as e:
            gid = d.get('id')
            out['rejected'].append(dict({'index': i, 'id': gid if isinstance(gid, str) else None, 'code': e.code},
                                        **({'rule': e.params['rule']} if 'rule' in e.params else {})))
            continue
        out['imported' if insert_game(con, user_id, g, 'import') else 'duplicates'] += 1
    return out


# ---------- static files ----------
SEGMENT_RE = re.compile(r'^[A-Za-z0-9_.-]+$')
JS_RE = re.compile(r'^[a-z0-9_-]+\.js$')
TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
         '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png',
         '.webmanifest': 'application/manifest+json'}
NO_CACHE, VENDOR_CACHE, ICON_CACHE = 'no-cache', 'public, max-age=2592000', 'public, max-age=86400'
INLINE_SCRIPT_RE = re.compile(r'<script\b([^>]*)>(.*?)</script\s*>', re.S | re.I)
SECURITY_HEADERS = (
    ('X-Content-Type-Options', 'nosniff'),
    ('Referrer-Policy', 'no-referrer'),
    ('X-Frame-Options', 'DENY'),
    ('Permissions-Policy', 'camera=(), microphone=(), geolocation=()'),
    ('Cross-Origin-Opener-Policy', 'same-origin'),
)
API_CSP = "default-src 'none'; frame-ancestors 'none'"
STATIC_CSP = "frame-ancestors 'none'"                                      # scripts and the service worker: no limits of their own


def static_target(path):
    """URL path -> (file relative to the root, content type, Cache-Control), or None.
    Only the game's files are reachable: never the database, the Python scripts or dotfiles."""
    fixed = {'/': 'index.html', '/index.html': 'index.html', '/manifest.webmanifest': 'manifest.webmanifest', '/sw.js': 'sw.js'}
    if path in fixed:
        name = fixed[path]
        return name, TYPES[os.path.splitext(name)[1]], NO_CACHE
    segs = path.split('/')[1:]
    if len(segs) < 2 or any(not SEGMENT_RE.match(s) or s.startswith('.') for s in segs):
        return None
    rel, name, ext = '/'.join(segs), segs[-1], os.path.splitext(segs[-1])[1]
    if segs[0] == 'js' and len(segs) == 2 and JS_RE.match(name):
        return rel, TYPES['.js'], NO_CACHE
    if segs[0] == 'icons' and len(segs) == 2 and ext == '.png':
        return rel, TYPES['.png'], ICON_CACHE
    if segs[0] == 'vendor' and (name == 'LICENSE' or ext in ('.js', '.css', '.woff2', '.txt')):
        return rel, TYPES['.txt'] if name == 'LICENSE' else TYPES[ext], VENDOR_CACHE
    return None


_csp_cache = {}


def page_csp(file):
    """The page's CSP, with the hash of every inline <script> (the import map); recomputed when the file changes."""
    mtime = file.stat().st_mtime_ns
    hit = _csp_cache.get(file)
    if hit and hit[0] == mtime:
        return hit[1]
    html = file.read_text('utf-8', errors='replace')
    hashes = []
    for attrs, body in INLINE_SCRIPT_RE.findall(html):
        if re.search(r'\bsrc\s*=', attrs, re.I):
            continue
        body = body.replace('\r\n', '\n').replace('\r', '\n')               # the HTML parser normalizes newlines
        hashes.append("'sha256-%s'" % base64.b64encode(hashlib.sha256(body.encode()).digest()).decode())
    csp = '; '.join([
        "default-src 'self'", ' '.join(["script-src 'self'", *hashes]), "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:", "font-src 'self'", "connect-src 'self' https:", "worker-src 'self'",
        "manifest-src 'self'", "base-uri 'none'", "form-action 'none'", "object-src 'none'", "frame-ancestors 'none'"])
    _csp_cache[file] = (mtime, csp)
    return csp


def origin_of(value):
    """'https://Host:8443/' -> 'https://host:8443' (None if it is not an http(s) origin)."""
    u = urlsplit(value.strip())
    if u.scheme not in ('http', 'https') or not u.hostname or u.path not in ('', '/') or u.query or u.fragment or u.username:
        return None
    return f'{u.scheme}://{u.netloc.lower()}'


# ---------- HTTP ----------
class Server(ThreadingHTTPServer):
    """Threaded server with a cap on the threads and optional TLS (handshake in the request thread, not in accept)."""
    daemon_threads = True
    max_threads = MAX_THREADS

    def __init__(self, address, handler, ssl_context=None):
        self.slots = threading.BoundedSemaphore(self.max_threads)
        super().__init__(address, handler)
        if ssl_context:
            self.socket = ssl_context.wrap_socket(self.socket, server_side=True, do_handshake_on_connect=False)

    def process_request(self, request, client_address):
        self.slots.acquire()                                                # when all are busy, new connections wait
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def handle_error(self, request, client_address):
        if isinstance(sys.exc_info()[1], (OSError, ssl.SSLError)):         # resets, timeouts, bad handshakes: not news
            return
        super().handle_error(request, client_address)


class Handler(BaseHTTPRequestHandler):
    server_version = 'Overclock/2'
    sys_version = ''
    timeout = REQUEST_TIMEOUT                                               # socket timeout for every read and write
    # configured by make_server()
    store = None
    root = ROOT
    host = '0.0.0.0'
    scheme = 'http'
    registration = 'open'
    invite_code = None
    cors_origins = frozenset(PUBLIC_ORIGINS)
    limits = RateLimiter()
    quiet = False
    csp, is_api, cors, body_done, body_limit = None, False, None, True, MAX_BODY

    def handle(self):
        if isinstance(self.connection, ssl.SSLSocket):
            try:
                self.connection.do_handshake()
            except (OSError, ValueError):
                return
        super().handle()

    def do_GET(self):
        self.route('GET')

    def do_HEAD(self):
        self.route('HEAD')

    def do_POST(self):
        self.route('POST')

    def do_OPTIONS(self):
        self.route('OPTIONS')

    def do_PUT(self):
        self.route('PUT')

    def do_DELETE(self):
        self.route('DELETE')

    def do_PATCH(self):
        self.route('PATCH')

    def log_message(self, fmt, *args):
        if not self.quiet:
            sys.stderr.write(f'{self.address_string()} [{self.log_date_time_string()}] {fmt % args}\n')

    def lang(self):
        return 'it' if self.headers.get('Accept-Language', '').strip().lower().startswith('it') else 'en'

    def end_headers(self):
        for k, v in SECURITY_HEADERS:
            self.send_header(k, v)
        self.send_header('Content-Security-Policy', self.csp or API_CSP)
        if self.is_api:
            self.send_header('Vary', 'Origin')
            if self.cors:
                self.send_header('Access-Control-Allow-Origin', self.cors)
                self.send_header('Access-Control-Expose-Headers', 'Retry-After')
        super().end_headers()

    def origin_ok(self, origin):
        o = origin_of(origin)
        return bool(o) and (o in self.cors_origins or o == origin_of(f'{self.scheme}://{self.headers.get("Host", "")}'))

    def route(self, method):
        self.csp, self.is_api, self.cors, self.body_done, self.body_limit = None, False, None, False, MAX_BODY
        path, _, query = self.path.partition('#')[0].partition('?')
        try:
            if path == '/api' or path.startswith('/api/'):
                self.is_api = True
                origin = self.headers.get('Origin')
                self.cors = origin if origin and self.origin_ok(origin) else None
                self.body_limit = MAX_IMPORT_BODY if path.rstrip('/') == '/api/import' else MAX_BODY
                if method == 'OPTIONS':
                    return self.preflight()
                if method not in ('GET', 'POST'):
                    raise ApiError(405, 'method_not_allowed')
                if origin and not self.cors and method == 'POST':           # a foreign page can't write, even without preflight
                    raise ApiError(403, 'origin_not_allowed')
                return self.api(method, path[5:].strip('/'), parse_qs(query))
            if method not in ('GET', 'HEAD'):
                raise ApiError(405, 'method_not_allowed')
            if path == '/overclock' or path.startswith('/overclock/'):     # old links
                rest = path[len('/overclock/'):].lstrip('/\\')              # never '//host': that would leave the site
                return self.redirect('/' + rest + (f'?{query}' if query else ''))
            return self.static(path, method == 'HEAD')
        except ApiError as e:
            self.drain()
            self.send_error_json(e)
        except Exception:
            traceback.print_exc()
            self.drain()
            self.send_error_json(ApiError(500, 'server_error'))

    def preflight(self):
        if not self.cors:
            raise ApiError(403, 'origin_not_allowed')
        self.send_response(204)
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept-Language')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Access-Control-Max-Age', '600')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def static(self, path, head):
        if path == '/favicon.ico':
            target = ('icons/favicon-32.png', TYPES['.png'], ICON_CACHE)
            if not (self.root / target[0]).is_file():
                self.send_response(204)
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
        else:
            target = static_target(path)
        if not target:
            return self.send_plain(404, 'Not found')
        rel, ctype, cache = target
        try:
            file = (self.root / rel).resolve()
            if not file.is_relative_to(self.root) or not file.is_file():   # symlinks can't lead outside the game
                return self.send_plain(404, 'Not found')
            data = file.read_bytes()
        except OSError:
            return self.send_plain(404, 'Not found')
        self.csp = page_csp(file) if rel == 'index.html' else STATIC_CSP
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', cache)
        self.end_headers()
        if not head:
            self.wfile.write(data)

    def redirect(self, to):
        self.send_response(301)
        self.send_header('Location', to)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def send_plain(self, code, txt):
        data = txt.encode()
        self.send_response(code)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, obj, code=200, headers=()):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def send_error_json(self, e):
        self.csp = None
        headers = [('Retry-After', str(e.params['retry_after']))] if 'retry_after' in e.params else []
        self.send_json(dict(e.params, error=e.message(self.lang()), code=e.code), e.status, headers)

    def content_length(self):
        try:
            return int(self.headers.get('Content-Length') or 0)
        except ValueError:
            return -1

    def drain(self):
        """Reads an unread body before an error reply, so the client gets the reply instead of a reset connection."""
        n = self.content_length()
        if self.body_done or self.close_connection or not 0 < n <= self.body_limit:
            return
        self.body_done = True
        try:
            self.rfile.read(n)
        except OSError:
            pass

    def body(self):
        n = self.content_length()
        if not 0 <= n <= self.body_limit:
            self.close_connection = True
            raise ApiError(413, 'body_too_large')
        if n == 0:
            self.body_done = True
            return {}
        if self.headers.get('Content-Type', '').split(';')[0].strip().lower() != 'application/json':
            raise ApiError(415, 'bad_content_type')
        raw = self.rfile.read(n)
        self.body_done = True
        try:
            if len(raw) != n:
                raise ValueError
            data = strict_json(raw.decode('utf-8'))
        except (ValueError, UnicodeDecodeError, RecursionError):
            raise ApiError(400, 'bad_request')
        if not isinstance(data, dict):
            raise ApiError(400, 'bad_request')
        return data

    def limit(self, kind, key):
        wait = self.limits.hit(kind, key)
        if wait:
            raise ApiError(429, 'rate_limited', retry_after=wait)

    def token(self):
        auth = self.headers.get('Authorization', '')
        return auth[7:].strip() if auth[:7].lower() == 'bearer ' else ''

    def user(self, con, required=True):
        token, row = self.token(), None
        if token:
            row = con.execute("""SELECT u.id, u.name, s.last_used FROM sessions s JOIN users u ON u.id = s.user_id
                                 WHERE s.token_hash = ?""", (sha(token),)).fetchone()
            if row and (row['last_used'] or '') < ago(days=SESSION_DAYS):    # expired
                con.execute('DELETE FROM sessions WHERE token_hash = ?', (sha(token),))
                con.commit()
                row = None
            elif row and row['last_used'] < ago(hours=1):                   # still in use: push the expiry forward
                con.execute('UPDATE sessions SET last_used = ? WHERE token_hash = ?', (now(), sha(token)))
        if required and not row:
            raise ApiError(401, 'auth_required')
        return row

    def api(self, method, route, q):
        parts = [unquote(p) for p in route.split('/')] if route else []
        head, n = (parts[0] if parts else ''), len(parts)
        handlers = {
            ('GET', 'info', 1): self.info,
            ('GET', 'me', 1): self.me,
            ('POST', 'register', 1): self.register,
            ('POST', 'login', 1): self.login,
            ('POST', 'logout', 1): self.logout,
            ('POST', 'games', 1): self.save_game,
            ('POST', 'import', 1): self.import_games,
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
            if any(k[1:] == (head, n) for k in handlers):
                raise ApiError(405, 'method_not_allowed')
            raise ApiError(404, 'not_found')
        con = self.store.open()
        try:
            with con:                                                       # commit if all goes well, otherwise roll back
                out = fn(con, q=q, arg=parts[1] if n > 1 else None)
        finally:
            con.close()
        self.send_json(out)

    # ---------- accounts ----------
    def info(self, con, **_):
        return {'app': 'overclock', 'version': API_VERSION, 'registration': self.registration, 'cpus': list(CPUS),
                'password_min': PASSWORD_MIN, 'password_max': PASSWORD_MAX}

    def me(self, con, **_):
        u = self.user(con, required=False)
        return {'user': {'name': u['name']} if u else None, 'cpus': list(CPUS)}

    def new_session(self, con, user_id):
        token = secrets.token_urlsafe(32)
        con.execute('INSERT INTO sessions (token_hash, user_id, created, last_used) VALUES (?, ?, ?, ?)',
                    (sha(token), user_id, now(), now()))
        return token

    def credentials(self):
        self.limit('auth', self.client_address[0])
        d = self.body()
        return text(d, 'name').strip(), text(d, 'password'), d

    def register(self, con, **_):
        name, password, d = self.credentials()
        if self.registration == 'closed':
            raise ApiError(403, 'registration_closed')
        if self.registration == 'invite':
            given = d.get('invite')
            if not isinstance(given, str) or not hmac.compare_digest(given.strip().upper().encode(), self.invite_code.upper().encode()):
                raise ApiError(403, 'bad_invite')
        if not NAME_RE.match(name):
            raise ApiError(400, 'bad_name')
        if not PASSWORD_MIN <= len(password) <= PASSWORD_MAX:
            raise ApiError(400, 'bad_password')
        salt = os.urandom(16)
        try:
            cur = con.execute('INSERT INTO users (name, name_key, salt, hash, rounds, created) VALUES (?, ?, ?, ?, ?, ?)',
                              (name, name.casefold(), salt, pw_hash(password, salt, ROUNDS), ROUNDS, now()))
        except sqlite3.IntegrityError:
            raise ApiError(409, 'name_taken')
        return {'token': self.new_session(con, cur.lastrowid), 'user': {'name': name}}

    def login(self, con, **_):
        name, password, _ = self.credentials()
        key = name.casefold()
        wait = self.limits.locked(key)
        if wait:
            raise ApiError(429, 'locked', retry_after=wait)
        row = con.execute('SELECT id, name, salt, hash, rounds FROM users WHERE name_key = ?', (key,)).fetchone()
        if row:
            ok = hmac.compare_digest(pw_hash(password, row['salt'], row['rounds']), row['hash'])
        else:
            pw_hash(password, DUMMY_SALT, ROUNDS)                           # same work as a real check: no hint the name is free
            ok = False
        if not ok:
            self.limits.failed(key)
            raise ApiError(401, 'bad_credentials')
        self.limits.succeeded(key)
        if row['rounds'] < ROUNDS:                                          # old hash: upgrade it now that we know the password
            salt = os.urandom(16)
            con.execute('UPDATE users SET salt = ?, hash = ?, rounds = ? WHERE id = ?',
                        (salt, pw_hash(password, salt, ROUNDS), ROUNDS, row['id']))
        return {'token': self.new_session(con, row['id']), 'user': {'name': row['name']}}

    def logout(self, con, **_):
        token = self.token()
        if token:
            con.execute('DELETE FROM sessions WHERE token_hash = ?', (sha(token),))
        return {'ok': True}

    # ---------- games ----------
    def save_game(self, con, **_):
        u = self.user(con)
        self.limit('games', u['id'])
        g = check_game(con, self.body(), live=True)
        prev = best_of(con, g['cpu'], g['mode'], u['id'])
        gid = insert_game(con, u['id'], g, 'live')
        if gid is None:                                                     # already saved (a retry): same answer, no new row
            row = dict(con.execute('SELECT * FROM games WHERE user_id = ? AND client_id = ?', (u['id'], g['client_id'])).fetchone())
            return self.game_result(con, u, row, None, duplicate=True)
        return self.game_result(con, u, dict(g, id=gid), prev)

    def game_result(self, con, u, row, prev, duplicate=False):
        cpu, mode = row['cpu'], row['mode']
        value = row['score'] if MODES[mode] == 'score' else (row['time_ms'] if row['finished'] else None)
        rows = board(con, cpu, mode)
        out = {'id': row['id'], 'cpu': cpu, 'value': value, 'best': not duplicate and value is not None and better(mode, value, prev),
               'record': best_of(con, cpu, mode, u['id']), 'rank': position(rows, u['name']), 'total': len(rows),
               'challenge': None}
        if row['challenge']:
            ch = find_challenge(con, row['challenge'])
            crow = board(con, cpu, mode, 'AND g.challenge = ?', (row['challenge'],))
            out['challenge'] = {'code': row['challenge'], 'daily': bool(ch and ch['daily']), 'rank': position(crow, u['name']),
                                'total': len(crow)}
        if duplicate:
            out['duplicate'] = True
        return out

    def import_games(self, con, **_):
        u = self.user(con)
        self.limit('import', u['id'])
        return import_results(con, u['id'], self.body())

    def leaderboard(self, con, q, **_):
        mode = mode_of((q.get('mode') or ['classica'])[0])
        cpu = cpu_of((q.get('cpu') or [None])[0])
        period = (q.get('period') or ['all'])[0]
        if period == 'week':
            rows = board(con, cpu, mode, 'AND g.created >= ?', (ago(days=7),), limit=50)
        else:
            period, rows = 'all', board(con, cpu, mode, limit=50)
        return {'cpu': cpu, 'mode': mode, 'period': period, 'rows': rows}

    # the link to scan: the server's network address (even if the request comes from localhost), with the challenge if any
    def invite(self, con, q, **_):
        url = public_url(self.host, self.server.server_address[1], self.scheme)
        code = (q.get('sfida') or [''])[0].strip().upper()
        if code:
            if not (CODE_RE.match(code) or DAILY_RE.match(code)):
                raise ApiError(400, 'bad_challenge_code')
            url += f'?sfida={code}'
        return {'url': url, 'svg': qr.svg(url)}

    # ---------- challenges ----------
    def daily(self, con, **_):
        ch = find_challenge(con, f'D-{date.today().isoformat()}')
        return {'code': ch['code'], 'cpu': ch['cpu'], 'mode': ch['mode'], 'seed': ch['seed'], 'date': ch['created'],
                'standings': board(con, ch['cpu'], ch['mode'], 'AND g.challenge = ?', (ch['code'],), limit=50)}

    def challenge(self, con, arg, **_):
        ch = find_challenge(con, arg or '')
        if not ch:
            raise ApiError(404, 'challenge_not_found')
        return {'code': ch['code'], 'cpu': ch['cpu'], 'mode': ch['mode'], 'seed': ch['seed'], 'daily': ch['daily'],
                'creator': ch['creator'], 'created': ch['created'],
                'standings': board(con, ch['cpu'], ch['mode'], 'AND g.challenge = ?', (ch['code'],), limit=50)}

    def create_challenge(self, con, **_):
        u = self.user(con)
        self.limit('challenge', u['id'])
        d = self.body()
        mode = mode_of(d.get('mode'))
        cpu = cpu_of(d.get('cpu'))
        seed = intval(d, 'seed', 2**31 - 1) if 'seed' in d else secrets.randbelow(1 << 30)
        game = intval(d, 'game', 2**62) if 'game' in d else None
        for _ in range(20):
            code = ''.join(secrets.choice(CODE_CHARS) for _ in range(5))
            try:
                con.execute('INSERT INTO challenges (code, cpu, mode, seed, creator, created) VALUES (?, ?, ?, ?, ?, ?)',
                            (code, cpu, mode, seed, u['id'], now()))
                break
            except sqlite3.IntegrityError:
                continue
        else:
            raise ApiError(500, 'code_failed')
        if game is not None:                                                # the game just played already counts for the challenge
            con.execute("""UPDATE games SET challenge = ? WHERE id = ? AND user_id = ? AND cpu = ? AND mode = ? AND seed = ?
                           AND challenge IS NULL""", (code, game, u['id'], cpu, mode, seed))
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

    # ---------- profile ----------
    def player(self, con, arg, **_):
        row = con.execute('SELECT id, name, created FROM users WHERE name_key = ?', ((arg or '').casefold(),)).fetchone()
        if not row:
            raise ApiError(404, 'player_not_found')
        t = con.execute("""SELECT COUNT(*) AS games, COALESCE(SUM(time_ms), 0) AS time_ms, COALESCE(SUM(ok), 0) AS ok,
                                  COALESCE(SUM(perfect), 0) AS perfect, COALESCE(SUM(good), 0) AS good,
                                  COALESCE(SUM(slow), 0) AS slow, COALESCE(SUM(glitches), 0) AS glitches,
                                  COALESCE(MAX(combo), 0) AS combo, COALESCE(MAX(peak), 0) AS peak
                           FROM games WHERE user_id = ?""", (row['id'],)).fetchone()
        # for each processor: record, rank and peak frequency (each with its own unit)
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


def make_server(store, host='0.0.0.0', port=8765, registration='open', invite_code=None, cors_origins=(), limits=None,
                ssl_context=None, root=ROOT, quiet=False):
    """Builds a configured (not yet running) server. Used by `serve` and by the tests."""
    if registration == 'invite' and not invite_code:
        raise ValueError('invite mode needs an invite code')
    handler = type('Handler', (Handler,), {
        'store': store, 'host': host, 'scheme': 'https' if ssl_context else 'http', 'registration': registration,
        'invite_code': invite_code, 'cors_origins': frozenset(PUBLIC_ORIGINS) | {origin_of(o) for o in cors_origins},
        'limits': limits or RateLimiter(), 'root': Path(root).resolve(), 'quiet': quiet})
    return Server((host, port), handler, ssl_context)


def tls_context(cert, key):
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(cert, key)
    return ctx


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.254.254.254', 1))                                    # no packet is sent: it only picks the interface
        return s.getsockname()[0]
    except OSError:
        return '127.0.0.1'
    finally:
        s.close()


def public_url(host, port, scheme='http'):
    """The address other devices on the network use to reach the server."""
    return f'{scheme}://{lan_ip() if host in ("0.0.0.0", "") else host}:{port}/'


def print_qr(url):
    print(qr.terminal(url))
    print(f'  scan it with a phone camera to open {url}')


# ---------- admin (command line) ----------
def find_user(con, name):
    return con.execute('SELECT id, name FROM users WHERE name_key = ?', (name.strip().casefold(),)).fetchone()


def admin_users(store):
    con = store.open()
    try:
        return [dict(r) for r in con.execute(
            """SELECT u.name, u.created, (SELECT COUNT(*) FROM games g WHERE g.user_id = u.id) AS games,
                      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS sessions,
                      (SELECT MAX(last_used) FROM sessions s WHERE s.user_id = u.id) AS last_seen
               FROM users u ORDER BY u.name_key""")]
    finally:
        con.close()


def admin_delete_user(store, name):
    """Deletes an account with its games and sessions; its challenges stay, without a creator. False if not found."""
    con = store.open()
    try:
        with con:
            u = find_user(con, name)
            if not u:
                return False
            con.execute('DELETE FROM games WHERE user_id = ?', (u['id'],))
            con.execute('DELETE FROM sessions WHERE user_id = ?', (u['id'],))
            con.execute('UPDATE challenges SET creator = NULL WHERE creator = ?', (u['id'],))
            con.execute('DELETE FROM users WHERE id = ?', (u['id'],))
        return True
    finally:
        con.close()


def admin_reset_password(store, name, password):
    """New password (same policy as registration) and every session closed. False if the user doesn't exist."""
    if not PASSWORD_MIN <= len(password) <= PASSWORD_MAX:
        raise ValueError(MESSAGES['bad_password'][0])
    con = store.open()
    try:
        with con:
            u = find_user(con, name)
            if not u:
                return False
            salt = os.urandom(16)
            con.execute('UPDATE users SET salt = ?, hash = ?, rounds = ? WHERE id = ?', (salt, pw_hash(password, salt, ROUNDS), ROUNDS, u['id']))
            con.execute('DELETE FROM sessions WHERE user_id = ?', (u['id'],))
        return True
    finally:
        con.close()


def admin_delete_game(store, game_id):
    con = store.open()
    try:
        with con:
            return con.execute('DELETE FROM games WHERE id = ?', (game_id,)).rowcount > 0
    finally:
        con.close()


def admin_import(store, name, path):
    """Imports an exported results file for a user, with the same checks as POST /api/import."""
    path = Path(path)
    if path.stat().st_size > MAX_IMPORT_BODY:
        raise ApiError(413, 'body_too_large')
    try:
        doc = strict_json(path.read_text('utf-8'))
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise ApiError(400, 'bad_format')
    con = store.open()
    try:
        with con:
            u = find_user(con, name)
            if not u:
                raise LookupError(name)
            return import_results(con, u['id'], doc)
    finally:
        con.close()


# ---------- command line ----------
def serve_options(p, sub=False):
    d = (lambda v: argparse.SUPPRESS) if sub else (lambda v: v)            # in 'serve' the defaults come from the main parser
    p.add_argument('--host', default=d('0.0.0.0'), help='interface (0.0.0.0 = all, 127.0.0.1 = this computer only)')
    p.add_argument('--port', type=int, default=d(8765))
    p.add_argument('--qr', action='store_true', default=d(False), help='only print the QR code of the game address and exit')
    p.add_argument('--registration', choices=('open', 'invite', 'closed'), default=d(None),
                   help='who can create accounts (default: open, or invite if --invite-code is given)')
    p.add_argument('--invite-code', default=d(None), metavar='CODE',
                   help='code needed to register in invite mode (if missing, one is generated and printed)')
    p.add_argument('--cors-origin', action='append', default=d([]), metavar='ORIGIN',
                   help=f'another site allowed to call the API, e.g. https://example.org (repeatable; '
                        f'{", ".join(PUBLIC_ORIGINS)} is always allowed)')
    p.add_argument('--cert', default=d(None), metavar='FILE', help='TLS certificate (PEM): serve over https')
    p.add_argument('--key', default=d(None), metavar='FILE', help='TLS private key (PEM), with --cert')


def db_option(p, sub=False):
    p.add_argument('--db', default=argparse.SUPPRESS if sub else str(ROOT / 'data' / 'overclock.db'),
                   help='SQLite file with accounts and games (default: data/overclock.db)')


def build_parser():
    p = argparse.ArgumentParser(prog='server.py', description='Overclock server for the local network (Python standard library only).',
                                epilog='Without a command the server starts, as with "serve".')
    serve_options(p)
    db_option(p)
    sub = p.add_subparsers(dest='cmd', metavar='command')
    s = sub.add_parser('serve', help='start the server (default)')
    serve_options(s, True)
    db_option(s, True)
    s = sub.add_parser('users', help='list the accounts')
    db_option(s, True)
    s = sub.add_parser('delete-user', help='delete an account with all its games')
    s.add_argument('name')
    db_option(s, True)
    s = sub.add_parser('reset-password', help="set a new password for an account (and sign it out everywhere)")
    s.add_argument('name')
    s.add_argument('--password', help='the new password (otherwise it is asked without echo)')
    db_option(s, True)
    s = sub.add_parser('delete-game', help='delete one game by its number')
    s.add_argument('id', type=int)
    db_option(s, True)
    s = sub.add_parser('import', help='import an exported results file into an account')
    s.add_argument('file')
    s.add_argument('--user', required=True, metavar='NAME')
    db_option(s, True)
    return p


def serve(a):
    if bool(a.cert) != bool(a.key):
        sys.exit('--cert and --key go together.')
    scheme = 'https' if a.cert else 'http'
    url = public_url(a.host, a.port, scheme)
    if a.qr:
        return print_qr(url)
    registration = a.registration or ('invite' if a.invite_code else 'open')
    if a.invite_code and registration != 'invite':
        sys.exit('--invite-code only makes sense with --registration invite.')
    invite_code = a.invite_code or (''.join(secrets.choice(CODE_CHARS) for _ in range(8)) if registration == 'invite' else None)
    origins = []
    for o in a.cors_origin:
        if not origin_of(o):
            sys.exit(f'Not a valid origin: {o} (expected something like https://example.org)')
        origins.append(o)
    ctx = None
    if a.cert:
        try:
            ctx = tls_context(a.cert, a.key)
        except (OSError, ssl.SSLError) as e:
            sys.exit(f'Cannot load the TLS certificate: {e}')
    store = Store(Path(a.db).expanduser().resolve())
    expired = store.cleanup()
    try:
        httpd = make_server(store, a.host, a.port, registration, invite_code, origins, ssl_context=ctx)
    except OSError as e:
        if e.errno not in (errno.EADDRINUSE, errno.EADDRNOTAVAIL):
            raise
        if e.errno == errno.EADDRNOTAVAIL:
            sys.exit(f'This computer does not have the address {a.host}: try without --host.')
        sys.exit(f'Port {a.port} is already in use: Overclock is probably already running (maybe in the background).\n'
                 f'  to stop it:          kill $(lsof -tiTCP:{a.port} -sTCP:LISTEN)\n'
                 f'  to see the QR code:  python3 server.py --qr{"" if a.port == 8765 else f" --port {a.port}"}\n'
                 f'  or use another port: python3 server.py --port {a.port + 1}')
    if (ROOT / 'index.html').is_file():
        page_csp(ROOT / 'index.html')                                       # the hashes of the inline scripts, ready
    print(f'Overclock listening on {a.host}:{a.port}')
    print(f'  from this computer: {scheme}://localhost:{a.port}/')
    if a.host in ('0.0.0.0', ''):
        print(f'  from other devices: {url}')
    print(f'  data: {store.path}   (Ctrl+C to stop)')
    print(f'  registration: {registration}' + (f'   invite code: {invite_code}' if invite_code else ''))
    if expired:
        print(f'  {expired} expired session(s) removed')
    if not a.host.startswith('127.'):
        print()
        print_qr(url)
    sys.stdout.flush()                                                      # visible right away even in a log file
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.')


def main(argv=None):
    a = build_parser().parse_args(argv)
    cmd = a.cmd or 'serve'
    if cmd == 'serve':
        return serve(a)
    store = Store(Path(a.db).expanduser().resolve())
    if cmd == 'users':
        rows = admin_users(store)
        for r in rows:
            print(f"{r['name']:<12}  since {r['created']}  {r['games']:>5} games  {r['sessions']} session(s)"
                  + (f"  last seen {r['last_seen']}" if r['last_seen'] else ''))
        print(f'{len(rows)} account(s)')
    elif cmd == 'delete-user':
        if not admin_delete_user(store, a.name):
            sys.exit(f'No account named {a.name}.')
        print(f'Deleted {a.name} and all their games.')
    elif cmd == 'reset-password':
        password = a.password
        if password is None:
            password = getpass.getpass('New password: ')
            if getpass.getpass('Again: ') != password:
                sys.exit('The passwords do not match.')
        try:
            if not admin_reset_password(store, a.name, password):
                sys.exit(f'No account named {a.name}.')
        except ValueError as e:
            sys.exit(str(e))
        print(f'Password of {a.name} changed; all their sessions are closed.')
    elif cmd == 'delete-game':
        if not admin_delete_game(store, a.id):
            sys.exit(f'No game number {a.id}.')
        print(f'Deleted game {a.id}.')
    elif cmd == 'import':
        try:
            r = admin_import(store, a.user, a.file)
        except LookupError:
            sys.exit(f'No account named {a.user}.')
        except OSError as e:
            sys.exit(f'Cannot read {a.file}: {e}')
        except ApiError as e:
            sys.exit(e.message())
        print(f"Imported {r['imported']} game(s), {r['duplicates']} already there, {len(r['rejected'])} rejected.")
        for x in r['rejected']:
            print(f"  #{x['index']} {x['id'] or '?'}: {x['code']}" + (f" ({x['rule']})" if 'rule' in x else ''))


if __name__ == '__main__':
    main()
