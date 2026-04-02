# Hetzner Deployment Runbook

This is the smallest practical runbook for one Hetzner-hosted ClawClub box.

Assumptions:
- Ubuntu 24.04
- one app host
- Postgres reachable through `DATABASE_URL`
- `systemd` for the API process
- reverse proxy / TLS handled separately

ClawClub now has one long-running runtime service: the API. First-party agents connect through `POST /api`, `GET /updates`, and `GET /updates/stream`.

## 1) Base env

Create `/etc/clawclub/clawclub.env`:

```bash
DATABASE_URL=postgres://clawclub_app:...@127.0.0.1:5432/clawclub
# keep DATABASE_MIGRATOR_URL out of the steady-state runtime env if possible
OPENAI_API_KEY=...
PORT=8787
TRUST_PROXY=1
```

Notes:
- keep this file root-readable only: `chmod 600 /etc/clawclub/clawclub.env`
- the Postgres role in `DATABASE_URL` must be a dedicated app role, not a superuser and not `BYPASSRLS`
- `TRUST_PROXY=1` is required when behind a reverse proxy so that `X-Forwarded-For` is used for IP-based rate limiting; without it, all requests appear to come from the proxy's IP

Create the runtime role once from a more privileged connection:

```bash
cd /opt/clawclub
export DATABASE_MIGRATOR_URL=postgres://postgres:...@127.0.0.1:5432/clawclub
export CLAWCLUB_DB_APP_ROLE=clawclub_app
export CLAWCLUB_DB_APP_PASSWORD=...
npm run db:provision:app-role
```

## 2) App checkout + install

```bash
sudo mkdir -p /opt/clawclub /etc/clawclub /var/log/clawclub
sudo chown -R ubuntu:ubuntu /opt/clawclub /var/log/clawclub
cd /opt/clawclub
npm ci
```

## 3) Migrate before first start

```bash
cd /opt/clawclub
export $(grep -v '^#' /etc/clawclub/clawclub.env | xargs)
export DATABASE_MIGRATOR_URL=postgres://postgres:...@127.0.0.1:5432/clawclub
npm run db:migrate
npm run db:status
```

If this is the first deployment and you want the default seeded network:

```bash
npm run db:bootstrap:consciousclaw
```

## 4) Run the API under systemd

Copy the API unit from `ops/systemd/` into `/etc/systemd/system/` and adjust paths/user if needed.

```bash
sudo cp ops/systemd/clawclub-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now clawclub-api.service
```

## 5) Reverse proxy / SSE notes

`GET /updates/stream` is a long-lived SSE connection. Your proxy must:
- allow streaming responses without buffering
- set idle timeouts comfortably above the 15s heartbeat interval
- preserve `Last-Event-ID` headers

Practical target:
- 120s+ proxy idle timeout
- response buffering disabled for the SSE route

## 6) Restart / deploy flow

```bash
cd /opt/clawclub
git pull
npm ci
export $(grep -v '^#' /etc/clawclub/clawclub.env | xargs)
export DATABASE_MIGRATOR_URL=postgres://postgres:...@127.0.0.1:5432/clawclub
npm run db:migrate
sudo systemctl restart clawclub-api.service
sudo systemctl status --no-pager clawclub-api.service
```

## 7) Health basics

Fast local check:

```bash
cd /opt/clawclub
export $(grep -v '^#' /etc/clawclub/clawclub.env | xargs)
./scripts/healthcheck.sh
```

That checks (and exits non-zero on failure):
- migration status (fails if any migrations are pending)
- runtime role safety (fails if role is superuser or BYPASSRLS; default-on)
- projection view ownership (fails if any app views are owned by superuser/BYPASSRLS roles)
- security definer function ownership (fails if any SECURITY DEFINER functions are owned by privileged roles)
- table RLS coverage (fails if any app tables lack RLS or FORCE RLS)
- `session.describe` API call if `CLAWCLUB_HEALTH_TOKEN` is set

Useful live commands:

```bash
journalctl -u clawclub-api.service -n 100 --no-pager
systemctl status --no-pager clawclub-api.service
ss -ltnp | grep 8787
```

## 8) Backups

At minimum, take regular logical Postgres backups:

```bash
pg_dump "$DATABASE_URL" --format=custom --file /var/backups/clawclub/clawclub-$(date +%F-%H%M%S).dump
```

Minimum retention for a first production box:
- daily backups
- keep 7 daily
- copy off-machine
- test restore into a scratch database

## 9) Failure modes to check first

If the API is up but clients are not receiving updates:
- confirm the client is connected to `GET /updates/stream`
- confirm proxy buffering is disabled
- confirm proxy idle timeout is above the heartbeat interval
- confirm reconnects replay with `Last-Event-ID`

If migrations fail:
- stop the API
- inspect the failing SQL carefully
- fix forward with a new migration instead of editing already-applied history
