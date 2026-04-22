# Troubleshooting

Common problems, how to diagnose them, and how to fix them.
Run `worklab doctor` first — it catches the most frequent issues automatically.

---

## Task stuck in `in_progress` forever

**Symptom:** A task remains `in_progress` indefinitely. The EventTimeline shows
no new events. The worker log may be empty or cut off mid-stream.

**Diagnosis:** The worker process crashed silently, but the coordinator's active
task map still holds the run as in-flight. The PID file may still exist.

**Fix:**
```bash
worklab stop
worklab start          # coordinator resets the active map on startup
```

If the task was genuinely abandoned (no worker log output), manually move it
back to `todo` via the task detail page → **Reset to todo**, then re-run.

Long-term: the `worker_timeout_ms` setting (default 30 min) will eventually
mark a hung run as timed out. Lower it if your tasks are typically shorter.
Hung task auto-detection is tracked in `docs/plans/phase-6-roadmap.md`.

---

## Reviewer always returns a null verdict

**Symptom:** The reviewer agent completes, a comment is posted, but the task
stays in `in_review` instead of transitioning to `done` or back to `in_progress`.
The system comment says `VERDICT: null` or the transition doesn't fire.

**Diagnosis:** `src/core/review.js` parses the reviewer's final text and requires
the **first non-blank line** to match `/^\s*VERDICT:\s*(APPROVE|REJECT)\b/`
exactly. Common mistakes: the reviewer prefaces with a summary paragraph,
uses lowercase (`verdict:`), or writes `APPROVED` instead of `APPROVE`.

**Fix:** Update the reviewer agent's instructions to make the format unambiguous:

```
Review the executor's work against the task instructions.
Your final message's first line must be exactly one of:
  VERDICT: APPROVE
  VERDICT: REJECT
If REJECT, add bullet-pointed notes on the lines below.
Do not write anything before the VERDICT line.
```

Source: `src/core/review.js` (`parseVerdict`), `src/core/context.js`
(`REVIEW_DIRECTIVE`).

---

## Ollama discovery returns an empty model list

**Symptom:** The Providers page shows your Ollama provider but the model
dropdown is empty. Attempting to select a model fails or shows no options.

**Diagnosis:** One of three causes:
1. Ollama is not running.
2. The base URL is wrong (wrong port or hostname).
3. No models have been pulled yet.

**Fix:**
```bash
# Verify Ollama is responding and has models:
curl http://localhost:11434/api/tags

# If empty — pull a model first:
ollama pull nomic-embed-text
ollama pull llama3.2

# Then retry discovery in the Providers UI.
```

Source: `src/core/providers.js` (`discoverModels` — hits `/api/tags` for
Ollama, `/v1/models` for OpenAI-compatible endpoints).

---

## Consolidation cron didn't fire

**Symptom:** `data/agents/<name>/MEMORY.md` hasn't been updated despite journal
activity. No consolidation run appears in the task runs list for the expected hour.

**Diagnosis:** Check these conditions in order:
1. `consolidation_enabled` must be `true` (Settings page).
2. `consolidation_hour` must match the expected local hour. Check `WORKLAB_TIMEZONE`
   if the server timezone differs from your local time.
3. The agent must be enabled and must have journal content that has changed since
   the last consolidation (tracked by SHA-256 hash of the journal file).
4. The coordinator must have been running at that hour — it doesn't back-fill
   missed ticks.

**Fix:** Confirm settings in the UI, then either wait for the next scheduled hour
or trigger consolidation manually via the agent detail page → **Consolidate now**.

Source: `src/coordinator/consolidation-cron.js`.

---

## Encryption key missing or regenerated

**Symptom:** After a restart or data directory move, the Providers page shows
all providers with blank API keys, and any provider test fails with an
authentication error.

**Diagnosis:** The `data/.provider-encryption-key` file was deleted, or the
`PROVIDER_ENCRYPTION_KEY` environment variable was changed. The stored ciphertext
was encrypted with the old key and cannot be decrypted with the new one.

**Fix:** Re-enter all provider API keys in **Settings → Providers**. There is no
way to recover the old ciphertext without the original key.

To prevent this: include `data/.provider-encryption-key` in your backups (it is
included by `worklab backup`). Alternatively, set `PROVIDER_ENCRYPTION_KEY`
explicitly in your environment so the key is independent of the data directory.

Source: `src/core/crypto.js`.

---

## Search returns no results

**Symptom:** Knowledge base search, agent memory search, or skill lookup returns
nothing despite content existing in the relevant files.

**Diagnosis:** The embeddings index is out of sync. This can happen after bulk
file edits, a data directory restore, or an embedding model change.

**Fix:**
1. Open **Settings → Search** and click **Reindex now**.
2. Wait for the indexer to complete (progress is shown in the UI).
3. Verify that the configured embedding model is reachable: `worklab doctor`
   reports embedding backend status.

If the model is unreachable (e.g. Ollama offline), fix that first — indexing
silently skips unreachable backends.

Source: `src/coordinator/search-indexer.js`, `src/core/embeddings.js`.

---

## Build fails / UI blank

**Symptom:** Opening http://localhost:7878 shows a blank page or a 404 for
`/assets/index.js`. The browser console shows a network error loading the bundle.

**Diagnosis:** `src/ui/dist/` is missing or stale — the frontend was not built,
or a previous build left an incomplete artifact.

**Fix:**
```bash
cd src/ui
npx vite build
cd ../..
worklab stop && worklab start
```

If `npx vite build` fails with missing dependencies, run `npm install` in the
repo root first. Never run `npm run build` on a host that only has production
dependencies installed.

---

## `worklab install-service` failed

**Symptom (macOS):** `launchctl load` exits with a permission error or
"service already loaded" message.

**Symptom (Linux):** `systemctl --user enable` fails with "Failed to connect
to bus" or "Unit not found".

**Diagnosis and fix:**
- Run `worklab doctor` — it reports the Node version and any obvious path issues.
- **macOS — "already loaded":** run `launchctl unload -w ~/Library/LaunchAgents/ai.worklab.plist`
  first, then re-run `worklab install-service`.
- **macOS — permission error on plist directory:** ensure `~/Library/LaunchAgents`
  is writable by your user.
- **Linux — "Failed to connect to bus":** you need a running systemd user session.
  Log in via a full login shell (not `su`), or run
  `loginctl enable-linger $USER` to allow user sessions without an active login.
- **Linux — systemd not available:** install worklab as a system service manually,
  or use a process manager like PM2.

Use `worklab install-service --dry-run` to inspect the generated service file
before writing it. Source: `src/cli/install-service.js`.

---

## One-stop check: `worklab doctor`

Always run this first. It checks:

- Node version (≥ 20)
- Database integrity (`PRAGMA integrity_check`)
- `data/config/mcp.json` JSON validity
- Provider encryption key availability
- Embedding backend reachability

```bash
$ worklab doctor
doctor: OK

# If issues:
$ worklab doctor
doctor: ISSUES
 - node 18.x < 20 required
 - embedding backend unreachable (ollama:nomic-embed-text): ECONNREFUSED ::1:11434
```

Fix reported issues before investigating further.
