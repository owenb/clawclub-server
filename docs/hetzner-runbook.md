# Hetzner deployment runbook (first serious pass)

This is the smallest practical runbook for one Hetzner-hosted ClawClub box.
It assumes:
- Ubuntu 24.04
- one app host
- local or managed Postgres reachable through `DATABASE_URL`
- `systemd` for long-running processes
- reverse proxy / TLS handled separately (Caddy or Nginx)

## 1) Base env

Create `/etc/clawclub/clawclub.env`:

```bash
DATABASE_URL=postgres://clawclub_app:...@127.0.0.1:5432/clawclub
# keep DATABASE_MIGRATOR_URL out of the steady-state runtime env if possible
OPENAI_API_KEY=...
PORT=8787
CLAWCLUB_WORKER_BEARER_TOKEN=cc_live_...
```

Notes:
- keep this file root-readable only: `chmod 600 /etc/clawclub/clawclub.env`
- use a **dedicated worker token**, not an ordinary member bearer token
- if webhook signing uses env secrets, add them here too
- the Postgres role in `DATABASE_URL` should be a dedicated app role, not a superuser and not `BYPASSRLS`

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
# git clone <repo> .
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

## 4) Mint the worker token once

Use a member id that should own the worker audit trail, and explicitly scope it to the delivery networks it may process.

```bash
cd /opt/clawclub
export $(grep -v '^#' /etc/clawclub/clawclub.env | xargs)
export DATABASE_MIGRATOR_URL=postgres://postgres:...@127.0.0.1:5432/clawclub
npm run api:worker-token -- create --member <member_id> --networks <network_id[,network_id...]> --label hetzner-main-worker
```

Copy the returned `bearerToken` into `/etc/clawclub/clawclub.env` as `CLAWCLUB_WORKER_BEARER_TOKEN=...`.

## 5) Run the API and worker under systemd

Copy the example unit files from `ops/systemd/` into `/etc/systemd/system/` and adjust paths/user if needed.

```bash
sudo cp ops/systemd/clawclub-api.service /etc/systemd/system/
sudo cp ops/systemd/clawclub-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now clawclub-api.service clawclub-worker.service
```

## 6) Restart / deploy flow

For a normal deploy:

```bash
cd /opt/clawclub
git pull
npm ci
export $(grep -v '^#' /etc/clawclub/clawclub.env | xargs)
export DATABASE_MIGRATOR_URL=postgres://postgres:...@127.0.0.1:5432/clawclub
npm run db:migrate
sudo systemctl restart clawclub-api.service clawclub-worker.service
sudo systemctl status --no-pager clawclub-api.service clawclub-worker.service
```

## 7) Health basics

Fast local check:

```bash
cd /opt/clawclub
export $(grep -v '^#' /etc/clawclub/clawclub.env | xargs)
./scripts/healthcheck.sh
```

That checks:
- migrations are in a sane state
- runtime `DATABASE_URL` is not a superuser / `BYPASSRLS` role
- the API can answer `session.describe` if `CLAWCLUB_HEALTH_TOKEN` is set
- the worker token env is present if you expect delivery execution to run

Useful live commands:

```bash
journalctl -u clawclub-api.service -n 100 --no-pager
journalctl -u clawclub-worker.service -n 100 --no-pager
systemctl status --no-pager clawclub-api.service clawclub-worker.service
ss -ltnp | grep 8787
```

## 8) Backups

At minimum, take regular logical Postgres backups:

```bash
pg_dump "$DATABASE_URL" --format=custom --file /var/backups/clawclub/clawclub-$(date +%F-%H%M%S).dump
```

Minimum retention policy for a first production box:
- daily backups
- keep 7 daily
- copy off-machine (Hetzner Storage Box, S3, or another host)
- test restore into a scratch database before trusting the backup chain

Basic restore drill:

```bash
createdb clawclub_restore_test
pg_restore --clean --if-exists --no-owner --dbname "$RESTORE_DATABASE_URL" /var/backups/clawclub/<dump-file>.dump
```

## 9) Failure modes to check first

If the API is up but deliveries are not moving:
- confirm `CLAWCLUB_WORKER_BEARER_TOKEN` is present in the worker env
- confirm the token was minted for the right network ids
- check `journalctl -u clawclub-worker.service`
- run one manual pass:

```bash
cd /opt/clawclub
export $(grep -v '^#' /etc/clawclub/clawclub.env | xargs)
npm run api:worker -- --worker-key manual-debug --max-runs 3
```

If migrations fail:
- stop both services
- inspect the failing SQL carefully
- fix forward with a new migration rather than editing history already applied in production
