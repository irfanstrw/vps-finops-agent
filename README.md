# VPS FinOps Agent

A FinOps dashboard and chat agent for VPS servers. VPS usage is priced with AWS **us-east-1 (N. Virginia)** on-demand rates and deducted from a credit balance.

## Deploy to Vercel

1. Push this folder to a GitHub repository.
2. In Vercel: **Add New → Project → Import** the repository. Leave Framework Preset as **Other** and the build settings empty (`vercel.json` already configures them).
3. In the project: **Storage → Create Database → Upstash for Redis** (free plan) and connect it to the project. This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically.
4. In **Settings → Environment Variables**, add:
   - `ADMIN_PASSWORD`: your login password
   - `SESSION_SECRET`: a long random string
   - `CRON_SECRET`: a long random string (protects the daily automation cron)
5. **Deployments → Redeploy** so the variables take effect.

The site is then available at `https://<project>.vercel.app`.

Without Redis, data on Vercel is lost between requests. The dashboard needs the Redis store to work there.

## Run locally

Requires Node.js 18+. No `npm install` needed.

```cmd
npm start
```

Open http://localhost:8080. Default password: `admin123`. Locally, data is stored in `data/db.json`.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_PASSWORD` | admin123 | Login password |
| `SESSION_SECRET` | derived from password | Signs session cookies |
| `CRON_SECRET` | | Required for the daily `/api/cron` call on Vercel |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | | Upstash Redis (set by the Vercel integration). Also accepts `UPSTASH_REDIS_REST_URL`/`_TOKEN` |
| `PUBLIC_URL` | (auto) | URL used in the agent install command |
| `AI_PRIMARY_API_KEY`, `AI_BACKUP_API_KEY` | | AI model keys (override the values set in the UI) |
| `PORT`, `HOST`, `DATA_FILE` | 8080, 0.0.0.0, data/db.json | Local server only |

## Connect a VPS

**Integrations → VPS → Connect VPS** → enter a name → run the command shown on the VPS over SSH. The page has step-by-step instructions and troubleshooting. The agent is read-only and runs as an unprivileged systemd service.

## VPS sample AWS

**Integrations → VPS → Tambah VPS sample AWS**: pick an EC2 instance type and EBS size. A sample VPS has no history. Its monthly cost is a projection that is added to the forecast only after **Aktifkan proyeksi** is clicked.

## AI model (optional)

**Integrations → AI Model**: configure a primary and a backup model. Any OpenAI-compatible Chat Completions API works (Gemini, Groq, OpenRouter, OpenAI, custom).

Order: primary model → backup model → rule-based agent. The model only picks the analysis tool and writes a short summary. All numbers come from code.

## Automations

Due automations run on every dashboard request and once a day through Vercel Cron (`/api/cron`, 01:00 UTC). Locally they also run every minute.

## Cost model

| Component | Rate (us-east-1) |
|---|---|
| EC2 | cheapest instance with at least the VPS vCPU and RAM, same architecture |
| EBS gp3 | $0.08/GB-month |
| Public IPv4 | $0.005/hour |
| Data Transfer Out | 100 GB/month free, then $0.09/GB |

Prices are a static snapshot in `lib/pricing.js`.
