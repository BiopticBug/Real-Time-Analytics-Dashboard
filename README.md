## Real-Time Analytics Dashboard (JS + React)

### Prereqs
- Node 18+
- Docker (for MongoDB)

### Bring-up
1. Start MongoDB:
   - `docker compose up -d`
2. Server:
   - `cd server`
   - Copy `.env.example` to `.env` and adjust as needed
   - `npm install`
   - `npm run dev`
3. Client:
   - `cd client`
   - `npm install`
   - `npm run dev`
4. Open the dashboard at `http://localhost:5173`.

### Demo
- The client fetches a JWT from `GET /token` and connects to WS at `ws://localhost:4001/ws`.
- Use "Send Synthetic Events" to push REST events to the server. Charts update in real time via WebSocket deltas.

### Notes
- REST fallback: `POST /ingest` with Bearer token.
- Health: `/health`, Readiness: `/ready`.
- Mongo Express UI: `http://localhost:8081`.


