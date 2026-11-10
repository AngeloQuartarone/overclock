# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **private vulnerability reporting**:
go to [AngeloQuartarone/overclock → Security → Report a vulnerability](https://github.com/AngeloQuartarone/overclock/security/advisories/new).

Do not open a public issue for a security problem. Include what you found, how to reproduce it
(requests, files, browser and version) and what an attacker could do with it. You will get an answer as soon as
possible; this is a hobby project, so please allow some time for a fix before disclosing anything publicly.

Only the latest version on the `main` branch is supported.

## What the server protects

`server.py` is a small LAN server (Python standard library only). It is designed so that:

- **Only the game's files are served**: `index.html`, `manifest.webmanifest`, `sw.js`, `js/*.js`, `icons/*.png` and
  the fonts/scripts/licenses under `vendor/`. The database, the Python scripts, dotfiles (`.git`) and anything outside
  the game folder are never reachable; paths with `..`, empty or hidden segments or unusual characters are refused.
- **Passwords are never stored in clear**: PBKDF2-SHA256 with a random salt per account (600,000 iterations for new
  and re-saved passwords; older hashes are upgraded at the next successful login). Login takes about the same time
  whether the name exists or not.
- **Sessions** are random bearer tokens; only their SHA-256 is stored. A session expires after 90 days without use,
  and logging out deletes it. No cookies are used.
- **Abuse limits**: per-IP limits on login and registration, a short lockout after repeated wrong passwords for a
  name, per-account limits on saved games, imports and new challenges, request size limits, socket timeouts and a
  cap on concurrent requests.
- **Registration** can be `open`, `invite` (a code is required) or `closed`.
- **Browser hardening**: a strict Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff`, no referrer,
  `Cross-Origin-Opener-Policy`, and CORS only for the page's own origin, the public site
  (`https://angeloquartarone.github.io`) and origins the host adds with `--cors-origin`.
- **Optional HTTPS** with `--cert`/`--key` (TLS 1.2 or later).

## What it does not protect

- **Scores are computed by the browser.** The server checks that every result is *plausible* (it could have come
  out of a real game), but anyone who can open the developer console can submit a fake, plausible score.
  Leaderboards are meant for friends, not for prizes.
- **The checksum in exported results files is not anti-cheat.** The algorithm is public; it only detects files that
  were edited by hand or damaged. Imported games go through the same plausibility checks as live ones.
- **Plain HTTP on a LAN is readable by others on the same network.** Without `--cert`/`--key`, passwords and session
  tokens travel unencrypted: anyone on the same Wi-Fi could capture them. Use HTTPS, or at least use a password
  for Overclock that you don't use anywhere else.
- **It is not meant to face the internet.** It has no account recovery, no e-mail verification and no audit log.
  If you expose it beyond your LAN, put it behind a proper reverse proxy with TLS, and note that rate limits are per
  connecting IP (behind a proxy, all clients share the proxy's address).
- **The host is trusted.** Whoever runs the server can read the database, reset passwords and delete accounts or games.
- **Data at rest** (`data/overclock.db`) is not encrypted; protect the file like any other private data.
