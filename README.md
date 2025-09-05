Backwards Replication Game

Overview
- A quick party game where a lead player records a short clip (<= 5s). Everyone else hears it and can play it forward and backward. Players then record their own voices to replicate the backwards version, submit, then vote for their 1st and 2nd favorite replication. Points: 3 for first, 1 for second.
- Designed to be mobile friendly and accessible from other devices on the same network.

How to run
- Requirements: Node.js 18+
- Install and start:
  - npm start
- The server listens on 0.0.0.0:8000 (so other devices can connect). Open in a browser:
  - http://YOUR_COMPUTER_IP:8000

Joining a game
- Enter a game code (e.g., PARTY) and your name.
- Share the code; once at least two players join, the game starts.

Device permissions
- The app needs microphone access for recording.
- On iOS Safari, you may have to tap once to enable audio playback (due to autoplay policies).

Game flow and states
The game operates in rounds. Each round flows through the following states. All steps have a 30-second deadline, but can advance faster if everyone finishes early.

1) lead_record
   - One player is the lead. They record a clip (max 5s) and submit it.
   - If they don’t submit within 30s, the round advances anyway.

2) replicate
   - Everyone else can play the lead’s clip forward and backward.
   - Each player records their replication (max 5s). They can re-record as many times as they want; the last recording before the deadline is the one that will be submitted automatically if they don’t press submit.
   - The player list shows “working/submitted” status for each player.
   - As soon as all non-lead players submit, the game advances to voting immediately (no need to wait the full 30s).

3) voting
   - Each player hears all submitted replications in a random order with anonymous labels (Clip #1, #2, ...). They vote for their first and second favorite.
   - When everyone votes, the game tallies and moves to the scoreboard without waiting further (otherwise it auto-advances after 30s).

4) scoreboard
   - Shows total scores and trophy icons with a celebratory animation.
   - Auto-advances to the next round after 30s.
   - Any player can tap “Start Next Round” to advance immediately.

Timing summary
- Lead record: 30s
- Replicate: 30s
- Voting: 30s (or earlier if all votes are in)
- Scoreboard: 30s (or earlier if a player presses Next Round)

Controls
- Play Forward/Backward: Available during replicate and later.
- Recording buttons: Start/Stop for 5s capped recordings for lead and replicators.
- Submit buttons: Uploads the current recording to the server.
- Voting selectors and Submit button: Choose distinct first/second choices.
- Next Round button: Available on the scoreboard for faster progression.

Server API (internal)
- POST /join { code, name } → { code, playerId, state }
- GET /sse?code=CODE&playerId=PID → EventSource stream of state updates
- POST /upload/lead?code=CODE&playerId=PID (binary audio/webm)
- POST /upload/replicate?code=CODE&playerId=PID (binary audio/webm)
- POST /vote { code, playerId, first, second }
- POST /control/start_next_round { code }
- GET /state?code=CODE&playerId=PID → current state snapshot

Notes for deployment/testing
- Self-host friendly: no external dependencies or build step needed.
- Audio is stored under ./data/CODE/round_N. Data persists as long as the process runs and the files stay on disk.
- If your network blocks mDNS/hostnames, connect by IP (e.g., http://192.168.1.50:8000).

Mobile compatibility
- Large touch targets, responsive topbar, and no heavy UI frameworks.
- Uses the browser MediaRecorder API (supported on most modern mobile browsers). If a device does not support audio/webm recording, try Chrome/Edge/Firefox on Android or iOS 14+ Safari.

Development notes
- The server is a single Node.js file (server.js). Static assets are under app/static.
- No external Node dependencies; npm start simply runs the server.

