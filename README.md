Backwards Words (backwardswords.com)

Overview
- A fast party game: one player records a short clip (<= 5s). Everyone listens, plays it forward/backward, records their best backwards imitation, and crowns a winner. Mobile‑friendly and LAN/Internet friendly.

Quick Start (local)
- Requirements: Node.js 18+
- Install and run: `npm ci && npm start`
- Open: http://localhost:8000

Production Hosting on a Remote Server

Server prep
- Install Node.js 18+ and Git.
- Clone the repo: `git clone https://github.com/<you>/<repo>.git && cd repo`
- Install: `npm ci`
- Copy env: `cp .env.example .env` and adjust ports if needed (`PORT=8000`, `HTTPS_PORT=8443`).

Run the app (systemd)
- Create `/etc/systemd/system/backwardswords.service`:
  - [Unit]
    Description=Backwards Words
    After=network.target
  - [Service]
    WorkingDirectory=/opt/backwardswords
    ExecStart=/usr/bin/node server.js
    Restart=always
    Environment=PORT=8000
    Environment=HTTPS_PORT=8443
  - [Install]
    WantedBy=multi-user.target
- Enable/start: `sudo systemctl daemon-reload && sudo systemctl enable --now backwardswords`.

Cloudflare SSL/TLS (recommended)
- Goal: Use Cloudflare for public HTTPS at https://backwardswords.com while the origin app runs on your server.

DNS
- In Cloudflare → DNS:
  - Add an A record `@` pointing to your server’s public IP. Proxied (orange cloud) ON.
  - Optionally add `www` CNAME → `backwardswords.com` (proxied ON) and set a redirect for `www` → root.

SSL/TLS mode
- Preferred: Full (strict). Generate an “Origin Certificate” in Cloudflare → SSL/TLS → Origin Server.
  - Download the certificate and private key to your server (e.g., `/etc/ssl/cloudflare/origin.crt` and `/etc/ssl/cloudflare/origin.key`).
  - In `.env`, set:
    - `SSL_CERT_FILE=/etc/ssl/cloudflare/origin.crt`
    - `SSL_KEY_FILE=/etc/ssl/cloudflare/origin.key`
  - Restart the service. The app will terminate HTTPS itself on `HTTPS_PORT` (default 8443).
- Simpler: Flexible. Cloudflare speaks HTTPS to users and HTTP to your origin.
  - Leave TLS vars unset. The app serves HTTP on `PORT` and Cloudflare proxies it.
  - Note: Flexible is less secure; prefer Full (strict) when possible.

Cloudflare rules (nice to have)
- Always Use HTTPS: enable in SSL/TLS → Edge Certificates.
- Non‑www → root redirect: Rules → Redirect Rules → `www.backwardswords.com/*` → `https://backwardswords.com/$1` (301)
- Bypass cache for SSE: Rules → Cache Rules → If Path equals `/sse*` → Cache Level: Bypass.

Ports and firewalls
- Open inbound TCP 8000 (HTTP) and, if you use Full/Strict with origin TLS, 8443 (HTTPS). Cloudflare supports connecting to port 8443.

Domain‑specific tweaks in code
- The server now detects Cloudflare/`X-Forwarded-*` headers and serves HTTP directly behind the proxy without forcing an origin‑port HTTPS redirect.
- The site title shows “Backwards Words”. All app requests are relative paths and work at `https://backwardswords.com`.

Game flow
- lead_record → replicate → voting → scoreboard, with auto‑advance when possible.
- Audio is saved under `./data/<CODE>/round_N/` on the server. The `data/` directory is intentionally not committed.

API (internal)
- POST `/join` { code, name } → { code, playerId, state }
- GET `/sse?code=CODE&playerId=PID` → EventSource updates
- POST `/upload/lead?code=CODE&playerId=PID` (binary audio)
- POST `/upload/replicate?code=CODE&playerId=PID` (binary audio)
- POST `/vote` { code, playerId, first, second }
- POST `/control/start_next_round` { code }
- GET `/state?code=CODE&playerId=PID` → snapshot

Notes
- Run under a process manager (systemd, pm2) for resilience.
- Avoid committing `data/` or TLS material; they’re excluded by `.gitignore`.
- If audio playback fails on certain mobiles, wait briefly after upload; the server produces reversed WAVs for maximum compatibility.
