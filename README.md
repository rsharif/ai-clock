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

- `POST /api/read-clock` — multipart `image` (upload) or JSON `{image: dataUrl, question}` (camera snapshot). Returns `{is_clock, time, quip}`.
- `GET /api/health` — uptime check (reports model + whether the key is set).
