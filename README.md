Backwards Words — Minimal README (for AI agents)

**What It Is**
- Simple party game server + static frontend. No DB. In‑memory game state. Audio files saved under `data/`.

**Repo Layout**
- `server.js`: single Node.js server (HTTP+HTTPS, API, static).
- `app/static/`: `index.html`, `style.css`, `app.js` frontend.
- `data/`: runtime audio storage per game code. Not committed.
- `backwardswords.com.pem` / `backwardswords.com.key`: origin TLS cert/key (ignored by Git).

**Requirements**
- Node.js >= 18 (tested on v24.x). No build step.

**Run**
- Install: `npm ci`
- Default (origin HTTPS on 8443; helper HTTP on 8000): `npm start`
  - Expect a NAT rule to forward public 443 → 8443 if hosting.
- Alternative (bind 80/443 directly): `npm run start:443`
  - Requires `sudo setcap cap_net_bind_service=+ep $(which node)` or root.

**Ports**
- HTTP: `PORT` (default 8000)
- HTTPS: `HTTPS_PORT` (default 8443)

**TLS Cert Source Order**
- `SSL_KEY` + `SSL_CERT` (PEM strings in env)
- `SSL_KEY_FILE` + `SSL_CERT_FILE` (+ optional `SSL_CA_FILE`)
- Local files `backwardswords.com.key` and `backwardswords.com.pem`
- Fallback: `cert/key.pem` via mkcert or self‑signed for dev

**Key Behavior**
- Codes and player names are normalized to UPPERCASE on input and display.
- Server generates reversed WAVs for robust mobile playback.
- Scoreboard shows podium; player list always shows scores and crowns top scorer(s).

**API (Minimal)**
- `POST /join` body `{ code, name, avatar? }` → `{ code, playerId, state }`
- `GET /sse?code=CODE&playerId=PID` → Server‑Sent Events with state
- `POST /upload/lead?code=CODE&playerId=PID` → binary body (audio)
- `POST /upload/replicate?code=CODE&playerId=PID` → binary body (audio)
- `POST /vote` body `{ code, playerId, first, second }`
- `POST /control/start_next_round` body `{ code }`
- `GET /state?code=CODE&playerId=PID` → public state snapshot

**Persistence / Data**
- Audio files: `data/<CODE>/round_<N>/`
- In‑memory game state (lost on restart). No migrations.

**Process Manager (systemd)**
- Install via script:
  - `chmod +x ./install-systemd.sh`
  - `./install-systemd.sh --user catid --workdir $(pwd) --port 8000 --https-port 8443`
  - This writes `/etc/systemd/system/backwardswords.service`, reloads systemd, enables and starts it.
  - View status: `systemctl status backwardswords --no-pager`
  - Tail logs: `journalctl -u backwardswords -f`

**Git Hygiene**
- `.gitignore` excludes: `data/`, `cert/`, `*.pem`, `*.key`, logs, node_modules.

**Notes**
- Behind Cloudflare, keep DNS proxied and use “Full (strict)” with an Origin Certificate. Public 443 → origin 8443 works with current NAT.
