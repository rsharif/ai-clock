# Camera box (Hetzner)

Cloud go2rtc gateway so the clock stream works without your Mac. One
Hetzner CX22 (Ubuntu 24.04, Ashburn region) running go2rtc behind Caddy.

## 1. Create the server

Hetzner Cloud Console → New server → CX22 → Ubuntu 24.04 → Ashburn, VA.
Add your SSH key. Note the IPv4 address.

## 2. Point DNS at it

In your DNS provider (e.g. GoDaddy), add an A record:

```
cam.example.com → <server IPv4>
```

Wait for it to resolve (`dig cam.example.com`).

## 3. Provision the box

```sh
scp deploy/hetzner/* root@<server>:/opt/aiclock-cam/
ssh root@<server> sh /opt/aiclock-cam/setup.sh
```

## 4. Configure secrets (on the server, never in git)

```sh
cd /opt/aiclock-cam
# hostname:
sed -i 's/cam.example.com/cam.YOURDOMAIN.com/' Caddyfile
# camera ids (from your Mac: curl 'http://localhost:1984/api/ring?refresh_token=<it>'):
vi go2rtc.yaml     # fill camera_id + device_id
vi .env            # RING_REFRESH_TOKEN=<fresh token from ring-auth-cli>
chmod 600 .env
docker compose up -d
```

## 5. Verify

- `https://cam.YOURDOMAIN.com/stream.html?src=clockcam` plays
- `https://cam.YOURDOMAIN.com/api/frame.jpeg?src=clockcam` returns a JPEG

## 6. Point ai-clock at it

Render dashboard (or local `.env`):

```
GO2RTC_URL=https://cam.YOURDOMAIN.com
RING_PLAYER_URL=https://cam.YOURDOMAIN.com/stream.html?src=clockcam
```

Then update `render.yaml` so future deploys keep the real hostname.

## Token expiry

When the stream dies with a Ring 406, refresh the token locally
(`ring-auth-cli`), update `/opt/aiclock-cam/.env`, and
`docker compose up -d` again.
