# CLI Reference

All worklab commands. The CLI entry point is `src/cli/index.js`; when installed
as a service or via `npm link`, the `worklab` binary maps to it.

```
worklab <start|stop|status|doctor|backup|install-service|uninstall-service>
```

---

### worklab start

Start the coordinator in the foreground.

**Usage:**
```
worklab start
```

**Example:**
```
$ worklab start
coordinator listening on :7878
```

**What it does:** Calls `startCoordinator()` in `src/coordinator.js`. Initializes
the DB, seeds data from template if the directory is empty, starts the HTTP server,
launches the search indexer and consolidation cron, then keeps the process alive.
Use `install-service` instead of running this directly in production.

---

### worklab stop

Send SIGTERM to a running coordinator.

**Usage:**
```
worklab stop
```

**Example:**
```
$ worklab stop
sent SIGTERM to 12345
```

**What it does:** Reads the PID from `data/.coordinator.pid` and sends SIGTERM.
If the file exists but the process is gone, it removes the stale PID file.
Source: `src/cli/stop.js`.

---

### worklab status

Show whether the coordinator is running and healthy.

**Usage:**
```
worklab status
```

**Example:**
```
$ worklab status
coordinator: running pid=12345 port=7878 health={"ok":true,"tasks":{"todo":2,"in_progress":1}}
```

**What it does:** Reads the PID file, checks `process.kill(pid, 0)` to confirm
the process is alive, then hits `/api/health` on the configured port and prints
the JSON response. Source: `src/cli/status.js`.

---

### worklab doctor

Run sanity checks and report any problems.

**Usage:**
```
worklab doctor
```

**Example:**
```
$ worklab doctor
doctor: OK

$ worklab doctor
doctor: ISSUES
 - node 18.0.0 < 20 required
 - mcp.json invalid: Unexpected token } in JSON
 - embedding backend unreachable (ollama:nomic-embed-text): ECONNREFUSED
```

**What it does:** Checks in order: Node version (≥ 20), SQLite integrity
(`PRAGMA integrity_check`), `data/config/mcp.json` JSON validity, provider
encryption key availability, and embedding backend reachability. Prints `OK` or
lists all failures. Source: `src/cli/doctor.js`.

---

### worklab backup

Create a compressed snapshot of the data directory.

**Usage:**
```
worklab backup [--out <directory>]
```

**Flags:**
- `--out <directory>` — destination directory (default: `~/worklab-backups/`)

**Example:**
```
$ worklab backup
backup: /Users/me/worklab-backups/20260422-143000.tar.gz
restore: mkdir -p /path/to/data && tar -xzf /Users/me/worklab-backups/20260422-143000.tar.gz -C /path/to/data
```

**What it does:** Flushes the SQLite WAL (`PRAGMA wal_checkpoint(TRUNCATE)`),
then runs `tar -czf` on the data directory. Excludes `logs/`, `.coordinator.pid`,
`*.db-wal`, and `*.db-shm`. Safe to run while the coordinator is running.
Source: `src/cli/backup.js`.

---

### worklab install-service

Register worklab as a persistent background service.

**Usage:**
```
worklab install-service [--dry-run]
```

**Flags:**
- `--dry-run` — print the generated service file without installing

**Example (macOS):**
```
$ worklab install-service
installed launchd service: /Users/me/Library/LaunchAgents/ai.worklab.plist
```

**Example (Linux):**
```
$ worklab install-service
installed systemd user service: /home/me/.config/systemd/user/worklab.service
```

**What it does:**
- **macOS** — writes `~/Library/LaunchAgents/ai.worklab.plist` and calls
  `launchctl load -w`. The service starts at login and restarts on crash.
- **Linux** — writes `~/.config/systemd/user/worklab.service`, runs
  `systemctl --user daemon-reload && systemctl --user enable --now worklab`.

stdout/stderr are logged to `data/logs/worklab.out.log` and `worklab.err.log`.
Source: `src/cli/install-service.js`.

---

### worklab uninstall-service

Remove the background service registration.

**Usage:**
```
worklab uninstall-service [--dry-run]
```

**Flags:**
- `--dry-run` — print what would be done without executing

**Example:**
```
$ worklab uninstall-service
uninstalled launchd service: /Users/me/Library/LaunchAgents/ai.worklab.plist
```

**What it does:** Unloads the launchd plist (macOS) or disables the systemd unit
(Linux), then deletes the service file. The coordinator process is stopped as
part of the unload/disable. Source: `src/cli/uninstall-service.js`.

---

## Typical Lifecycle

```bash
# First-time setup — macOS
worklab install-service
# Starts at login. Service file: ~/Library/LaunchAgents/ai.worklab.plist

# First-time setup — Linux (systemd user session)
worklab install-service
# Unit: ~/.config/systemd/user/worklab.service

# Daily use
worklab status              # PID, port, health JSON with task counts
worklab doctor              # node version, DB integrity, mcp.json, encryption key, embeddings

# Create a snapshot before upgrades or experiments
worklab backup              # → ~/worklab-backups/YYYYMMDD-HHMMSS.tar.gz

# Restart after config change (no install-service step needed)
worklab stop && worklab start   # or let the service manager restart it

# Remove the service
worklab uninstall-service
```
