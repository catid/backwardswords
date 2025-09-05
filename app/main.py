from __future__ import annotations

import asyncio
import os
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles


DATA_DIR = Path("data")
DATA_DIR.mkdir(exist_ok=True)


def now() -> float:
    return time.time()


@dataclass
class Player:
    id: str
    name: str
    connected: bool = False
    # WebSocket connections for this player (support reconnection / multi-tabs)
    sockets: Set[WebSocket] = field(default_factory=set)


@dataclass
class RoundState:
    index: int
    lead_player_id: str
    state: str  # lead_record, replicate, voting, scoreboard
    deadline: float
    lead_clip_path: Optional[Path] = None
    # player_id -> path
    replicates: Dict[str, Path] = field(default_factory=dict)
    # player_id -> (first, second) votes (target player ids)
    votes: Dict[str, Tuple[Optional[str], Optional[str]]] = field(default_factory=dict)


class Game:
    def __init__(self, code: str):
        self.code = code
        self.players: Dict[str, Player] = {}
        self.created_at = now()
        self.rounds: List[RoundState] = []
        self.current_round: Optional[RoundState] = None
        self.sockets: Set[WebSocket] = set()
        self.lock = asyncio.Lock()
        self.scores: Dict[str, int] = {}

    def dir(self) -> Path:
        d = DATA_DIR / self.code
        d.mkdir(exist_ok=True, parents=True)
        return d

    def to_public(self, requester: Optional[str] = None) -> dict:
        # Prepare state for clients
        players = [
            {
                "id": p.id,
                "name": p.name,
                "connected": p.connected,
            }
            for p in self.players.values()
        ]
        cur_round: Optional[dict] = None
        if self.current_round:
            r = self.current_round
            cur_round = {
                "index": r.index,
                "state": r.state,
                "deadline": r.deadline,
                "leadPlayerId": r.lead_player_id,
                "leadClipUrl": self.clip_url(r.lead_clip_path) if r.lead_clip_path else None,
                "replicateStatus": {pid: (pid in r.replicates) for pid in self.players.keys()},
                "votesStatus": {pid: (pid in r.votes) for pid in self.players.keys()},
            }

            # Clips to present anonymized for voting to a requester
            if requester and r.state in ("voting", "scoreboard"):
                # Build anonymous list excluding requester's own replicate
                items: List[Tuple[str, Path]] = [
                    (pid, path) for pid, path in r.replicates.items() if pid != requester
                ]
                # Shuffle deterministically per requester using round index
                import random

                rnd = random.Random(f"{self.code}:{r.index}:{requester}")
                rnd.shuffle(items)
                cur_round["voteClips"] = [
                    {
                        "id": f"clip_{i}",
                        "clipUrl": self.clip_url(path),
                        "ownerHiddenId": pid,  # not shown in UI; used for submitting votes
                    }
                    for i, (pid, path) in enumerate(items)
                ]

        return {
            "code": self.code,
            "players": players,
            "currentRound": cur_round,
            "scores": self.scores,
        }

    def clip_url(self, path: Optional[Path]) -> Optional[str]:
        if not path:
            return None
        # Static mapping under /audio/{game}/{filename}
        return f"/audio/{self.code}/{path.name}"


GAMES: Dict[str, Game] = {}


app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

static_dir = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.get("/")
async def index() -> HTMLResponse:
    html = (static_dir / "index.html").read_text(encoding="utf-8")
    return HTMLResponse(html)


@app.get("/audio/{game_code}/{filename}")
async def get_audio(game_code: str, filename: str):
    p = DATA_DIR / game_code / filename
    if not p.exists():
        raise HTTPException(status_code=404, detail="Audio not found")
    return FileResponse(str(p), media_type="audio/webm")


def get_or_create_game(code: str) -> Game:
    game = GAMES.get(code)
    if not game:
        game = Game(code)
        GAMES[code] = game
    return game


@app.post("/join")
async def join_game(code: str = Form(...), name: str = Form(...)):
    code = code.upper()
    game = get_or_create_game(code)
    async with game.lock:
        # If name exists, reuse player id, else create new
        for p in game.players.values():
            if p.name == name:
                pid = p.id
                break
        else:
            pid = uuid.uuid4().hex
            game.players[pid] = Player(id=pid, name=name)
            game.scores.setdefault(pid, 0)

        # Create round if none and at least 2 players
        if not game.current_round and len(game.players) >= 2:
            lead_id = list(game.players.keys())[int(now()) % len(game.players)]
            r = RoundState(
                index=1,
                lead_player_id=lead_id,
                state="lead_record",
                deadline=now() + 30,
            )
            game.current_round = r

    return {"code": game.code, "playerId": pid, "state": game.to_public(requester=pid)}


@app.websocket("/ws/{code}")
async def ws_game(ws: WebSocket, code: str):
    await ws.accept()
    code = code.upper()
    game = get_or_create_game(code)
    player_id: Optional[str] = None
    try:
        # First message must be init with playerId
        init = await ws.receive_json()
        player_id = init.get("playerId")
        if not player_id or player_id not in game.players:
            await ws.close(code=4000)
            return

        async with game.lock:
            game.sockets.add(ws)
            p = game.players[player_id]
            p.connected = True
            p.sockets.add(ws)
            await send_state(game)

        while True:
            msg = await ws.receive_json()
            # Only ping/pong for now
            if msg.get("type") == "ping":
                await ws.send_json({"type": "pong", "t": now()})

    except WebSocketDisconnect:
        pass
    finally:
        async with game.lock:
            if ws in game.sockets:
                game.sockets.remove(ws)
            # remove from player sockets
            if player_id and player_id in game.players and ws in game.players[player_id].sockets:
                game.players[player_id].sockets.remove(ws)
                game.players[player_id].connected = len(game.players[player_id].sockets) > 0
            await send_state(game)


async def send_state(game: Game):
    state = game.to_public()
    to_remove: List[WebSocket] = []
    for ws in list(game.sockets):
        try:
            await ws.send_json({"type": "state", "state": state})
        except Exception:
            to_remove.append(ws)
    for ws in to_remove:
        game.sockets.discard(ws)


@app.post("/upload/lead")
async def upload_lead(
    code: str = Form(...),
    playerId: str = Form(...),
    file: UploadFile = File(...),
):
    game = get_or_create_game(code.upper())
    async with game.lock:
        if not game.current_round or game.current_round.state != "lead_record":
            raise HTTPException(400, "Not accepting lead clip now")
        if game.current_round.lead_player_id != playerId:
            raise HTTPException(403, "Only lead player can upload lead clip")
        # Save file
        round_dir = game.dir() / f"round_{game.current_round.index}"
        round_dir.mkdir(parents=True, exist_ok=True)
        fname = f"lead_{uuid.uuid4().hex}.webm"
        path = round_dir / fname
        with path.open("wb") as f:
            content = await file.read()
            f.write(content)
        game.current_round.lead_clip_path = path
        # Immediately move to replicate state with 30 seconds window
        game.current_round.state = "replicate"
        game.current_round.deadline = now() + 30
    await send_state(game)
    return {"ok": True, "leadClipUrl": game.clip_url(path)}


@app.post("/upload/replicate")
async def upload_replicate(
    code: str = Form(...),
    playerId: str = Form(...),
    file: UploadFile = File(...),
):
    game = get_or_create_game(code.upper())
    async with game.lock:
        r = game.current_round
        if not r or r.state != "replicate":
            raise HTTPException(400, "Not accepting replications now")
        if playerId not in game.players:
            raise HTTPException(404, "Unknown player")
        round_dir = game.dir() / f"round_{r.index}"
        round_dir.mkdir(parents=True, exist_ok=True)
        fname = f"rep_{playerId}_{uuid.uuid4().hex}.webm"
        path = round_dir / fname
        with path.open("wb") as f:
            content = await file.read()
            f.write(content)
        r.replicates[playerId] = path
    await send_state(game)
    return {"ok": True, "clipUrl": game.clip_url(path)}


@app.post("/vote")
async def submit_vote(
    code: str = Form(...),
    playerId: str = Form(...),
    first: Optional[str] = Form(None),
    second: Optional[str] = Form(None),
):
    game = get_or_create_game(code.upper())
    async with game.lock:
        r = game.current_round
        if not r or r.state != "voting":
            raise HTTPException(400, "Not in voting phase")
        if playerId not in game.players:
            raise HTTPException(404, "Unknown player")
        if first == second and first is not None:
            raise HTTPException(400, "First and second choices must be different")
        r.votes[playerId] = (first, second)
    await send_state(game)
    return {"ok": True}


@app.post("/control/start_next_round")
async def start_next_round(code: str = Form(...)):
    game = get_or_create_game(code.upper())
    async with game.lock:
        if not game.current_round or game.current_round.state != "scoreboard":
            raise HTTPException(400, "Not at end of round")
        # Choose next lead player: rotate
        players = list(game.players.keys())
        if not players:
            raise HTTPException(400, "No players")
        prev_lead = game.current_round.lead_player_id
        if prev_lead in players:
            idx = (players.index(prev_lead) + 1) % len(players)
        else:
            idx = 0
        lead_id = players[idx]
        r = RoundState(index=game.current_round.index + 1, lead_player_id=lead_id, state="lead_record", deadline=now() + 30)
        game.rounds.append(game.current_round)
        game.current_round = r
    await send_state(game)
    return {"ok": True}


async def round_tick_loop():
    while True:
        await asyncio.sleep(0.5)
        for game in list(GAMES.values()):
            async with game.lock:
                r = game.current_round
                if not r:
                    continue
                if now() < r.deadline:
                    continue
                # Deadline reached: advance state
                if r.state == "lead_record":
                    # If no lead clip uploaded, keep waiting until deadline then advance to replicate with empty clip? We'll just extend until uploaded or 30s passed, then cancel round.
                    if not r.lead_clip_path:
                        # Extend a little grace or move on to replicate anyway (players will replicate silence)
                        # Move to replicate with 30 seconds window
                        r.state = "replicate"
                        r.deadline = now() + 30
                    else:
                        r.state = "replicate"
                        r.deadline = now() + 30
                elif r.state == "replicate":
                    # Move to voting for up to 30 minutes
                    r.state = "voting"
                    r.deadline = now() + 30 * 60
                elif r.state == "voting":
                    # Tally votes
                    tally_and_finish_round(game)
                elif r.state == "scoreboard":
                    # Do nothing until next round started
                    pass
            await send_state(game)


def tally_and_finish_round(game: Game):
    r = game.current_round
    if not r:
        return
    # points: 3 for first, 1 for second
    points: Dict[str, int] = {pid: 0 for pid in game.players}
    for voter, (first, second) in r.votes.items():
        if first in game.players:
            points[first] = points.get(first, 0) + 3
        if second in game.players:
            points[second] = points.get(second, 0) + 1
    for pid, pts in points.items():
        game.scores[pid] = game.scores.get(pid, 0) + pts
    r.state = "scoreboard"
    r.deadline = now() + 10**9  # essentially no auto-advance


@app.on_event("startup")
async def on_start():
    asyncio.create_task(round_tick_loop())


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run("app.main:app", host=host, port=port, reload=False)

