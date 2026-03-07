# Aura Sandbox Template

Pre-baked e2b sandbox with all tools Aura needs — no install latency on first use.

## Tools included

| Tool | Purpose |
|------|---------|
| `psql` | PostgreSQL queries against Aura's own DB |
| `gh` | GitHub CLI for PR/issue work |
| `gcloud` / `bq` | BigQuery + GCS operations |
| `jq` | JSON parsing in shell scripts |
| `rg` (ripgrep) | Fast codebase search |
| `python3` + `psycopg2` | Direct DB access via Python |
| `vercel` | CLI for deployment logs |
| `claude` | Claude Code agent dispatch |
| `gcsfuse` | Mount GCS bucket at `/mnt/aura-files` |
| `pdftotext` | PDF text extraction |

## Building a new template

```bash
# Dev build (for testing)
E2B_API_KEY=e2b_xxx npx tsx sandbox/build.ts

# Production build
E2B_API_KEY=e2b_xxx npx tsx sandbox/build.ts --prod
```

After the build, copy the `Template ID` from the output and set:
```
E2B_TEMPLATE_ID=<id>  # in Vercel env vars
```

## When to rebuild

Rebuild the template when you add new tools to `template.ts`. The sandbox
code itself (`src/lib/sandbox.ts`) picks up the new template via `E2B_TEMPLATE_ID`.
No code changes needed — just rebuild + update the env var.
