# AI Clock

The world's first sarcastic AI clock. Ask "What time is it right now?" — a vision model reads a clock photo and answers, with attitude.

- **Upload.** Upload a clock photo; `POST /api/read-clock` returns `{is_clock, time, quip}`.
- **Webcam.** Start the webcam preview; Ask grabs the current frame (canvas snapshot) and posts it to the same endpoint.
- **Ring fixed camera.** Watch Ring embeds the go2rtc player; Ask posts `{ring: true}` and the backend pulls the gateway frame itself (`GO2RTC_URL`, `RING_SRC` in `.env`).
- **No API keys in the browser.** Keys live server-side in `.env` (`LLM_API_KEY`, Ring refresh token stays in go2rtc).

## Run locally

Requires **Node 18+**.

```
cd ai-clock
npm install
npm test
cp .env.example .env
# edit .env: set LLM_API_KEY
npm start
# open http://localhost:8001
```

Camera needs a secure context: `localhost` works; any hosted domain needs HTTPS.

## API

- `POST /api/read-clock` — multipart `image` (upload) or JSON `{image: dataUrl, question}` (camera snapshot), or `{ring: true}` (Ring gateway frame). Returns `{is_clock, time, quip, digital, model_used}`.
- `GET /api/stats` — per-model rows: reads, accuracy %, mean in/out tokens, p90 response. Needs `MONGO_URI`, else 503.
- `POST /api/signups` — `{email}` validated server-side, stored in the `signups` collection (unique per address). Needs `MONGO_URI`, else 503.
- `GET /api/health` — uptime check (reports each model's key status).

## Contribute tab

Contributions go through Stripe's buy button (`stripe-buy-button` in `index.html`, dashboard → Payment Links); no card data touches this app and no money logic lives here. The publishable key is public by design. Currently a **test-mode** snippet (`pk_test_…`) — swap in the live snippet for real money. Refunds, receipts, and tracking all happen in the Stripe dashboard.

## Statistics tab

Every model attempt is stored in MongoDB (`model_usage` collection) with the reading, `expected_response` (the client wall-clock moment as h:mm AM/PM — the browser posts `clientNow` plus `clientTzOffset` because the server may run in another timezone, e.g. UTC on Render; an epoch alone would re-render in the server zone), `off_by_sec` (how far the reading landed, AM/PM-blind), accuracy (within ±180s of the client moment), token counts, request/response timestamps, and a success flag. The Statistics tab aggregates one row per model. Set `MONGO_URI` in `.env` (same Atlas approach as the receipt tracker) and restart — without it, reads still work but the tab reports "database not configured".
