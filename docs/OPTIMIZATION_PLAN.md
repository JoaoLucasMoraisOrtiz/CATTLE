# ReDo! v2 — Performance Optimization Plan

> Generated from full codebase analysis. Each issue references specific file:line locations.

---

## Table of Contents

1. [Critical: Full-Table Scans in Hybrid Search](#1-critical-full-table-scans-in-hybrid-search)
2. [Critical: SuggestSymbols Embeds Every Function Body](#2-critical-suggestsymbols-embeds-every-function-body)
3. [Critical: SearchSymbol Parses All Files from Recent Commits](#3-critical-searchsymbol-parses-all-files-from-recent-commits)
4. [High: ListCommits Shells Out Per-Commit for File Count](#4-high-listcommits-shells-out-per-commit-for-file-count)
5. [High: FindGitRepos Called Repeatedly Without Caching](#5-high-findgitrepos-called-repeatedly-without-caching)
6. [High: ingestAll Embeds All New Messages Every 30s](#6-high-ingestall-embeds-all-new-messages-every-30s)
7. [High: ListDirectory Shells Out to git ls-files Per Repo](#7-high-listdirectory-shells-out-to-git-ls-files-per-repo)
8. [High: SendInput Writes Char-by-Char with Sleep](#8-high-sendinput-writes-char-by-char-with-sleep)
9. [Medium: Python Embed Server is Single-Threaded Flask](#9-medium-python-embed-server-is-single-threaded-flask)
10. [Medium: Bubble Sort Used for Ranking](#10-medium-bubble-sort-used-for-ranking)
11. [Medium: getProjectPath Scans All Projects Linearly](#11-medium-getprojectpath-scans-all-projects-linearly)
12. [Medium: No Embedding Cache — Same Text Re-embedded](#12-medium-no-embedding-cache--same-text-re-embedded)
13. [Medium: Frontend File Tree Cache Never Invalidated](#13-medium-frontend-file-tree-cache-never-invalidated)
14. [Medium: KBRepo.FindRelevant Full-Table Scan Duplicates Pattern](#14-medium-kbrepofindrelevant-full-table-scan-duplicates-pattern)
15. [Medium: MarkChanged Fetches Patch Per-File Redundantly](#15-medium-markchanged-fetches-patch-per-file-redundantly)
16. [Low: Frontend Event Listeners Not Cleaned Up on Tab Switch](#16-low-frontend-event-listeners-not-cleaned-up-on-tab-switch)
17. [Low: ParseFile HTTP Call Per File — No Batching](#17-low-parsefile-http-call-per-file--no-batching)
18. [Low: cosineSim Missing sqrt — Incorrect Results](#18-low-cosinesim-missing-sqrt--incorrect-results)
19. [Low: SQLite Connection Not Pooled or Configured](#19-low-sqlite-connection-not-pooled-or-configured)
20. [Low: Token Refresh Interval Polls All Sessions](#20-low-token-refresh-interval-polls-all-sessions)
21. [Prioritized Roadmap](#prioritized-roadmap)

---

## 1. Critical: Full-Table Scans in Hybrid Search

**Files:** `internal/infra/store/message_repo.go:62-80`, `internal/infra/store/kb_repo.go:40-58`

**Problem:** Both `FindRelevant` methods do a full-table scan to find embedding-only candidates:

```go
// message_repo.go:62
allRows, _ := r.db.Query(
    `SELECT id, project, agent, session_id, role, content, embedding,
            CAST(strftime('%s', created_at) AS INTEGER) AS ts
     FROM messages WHERE project=?`, project,
)
```

```go
// kb_repo.go:40
allRows, _ := r.db.Query(
    `SELECT id, project, source_file, chunk_index, content, embedding FROM kb_chunks WHERE project=?`, project,
)
```

Every call loads **all rows** for a project, decodes every embedding blob (768 floats × 4 bytes = 3KB each), and computes cosine similarity in Go. For a project with 10K messages, this is ~30MB of blob data decoded per query.

**Impact:** O(n) per search call. Becomes the dominant bottleneck as conversation history grows.

**Solution:** Use a vector similarity index. Options ranked by effort:

1. **Quick fix (low effort):** Add a `LIMIT` + pre-filter. Only scan rows created within a time window (e.g., last 30 days) or with FTS score > 0. Skip the full scan if FTS already returned enough results.
2. **Medium fix:** Store embeddings in a separate SQLite table with a rowid-indexed structure. Pre-compute and cache the top-K neighbors for each project periodically.
3. **Best fix:** Use `sqlite-vss` (SQLite vector search extension) or switch the embedding search to a dedicated vector store (e.g., Qdrant, ChromaDB). This gives O(log n) approximate nearest neighbor search.

**Complexity:** Quick fix = Low, sqlite-vss = Medium, external vector DB = High

---

## 2. Critical: SuggestSymbols Embeds Every Function Body

**File:** `app.go:488-540`

**Problem:** `SuggestSymbols` does the following for every call:
1. Gets last 5 commits per repo (`ListCommits` → shells out to git)
2. Gets diff files for each commit (`GetDiffFiles` → shells out to git per commit)
3. Parses every changed file via HTTP to Python sidecar (`ParseFile`)
4. Reads source code for every symbol (`ExtractCode` → `os.ReadFile` per symbol)
5. Embeds ALL symbol texts in one batch (`EmbedBatch`)

For a Spring Boot project with 5 commits touching 20 files with 15 symbols each = 300 symbols × ~500 chars = 150KB sent to the embedding server in one batch. The embedding model processes this sequentially.

```go
// app.go:510-520
for f := range fileSet {
    syms, _ := codeview.ParseFile("http://127.0.0.1:9999", filepath.Join(repo, f))
    // ...
    allSymbols = append(allSymbols, syms...)
}
// app.go:530
vecs, err := a.embedder.EmbedBatch(texts)
```

**Impact:** 5-30 seconds per call depending on project size. Blocks the UI.

**Solution:**
1. **Cache symbol embeddings** in SQLite keyed by `(file_path, symbol_name, file_hash)`. Only re-embed when the file changes.
2. **Limit scope:** Instead of last 5 commits, use only the currently selected commit or branch diff.
3. **Background pre-computation:** Embed symbols during `ingestAll` loop, not on-demand.
4. **Truncate aggressively:** Cap symbol text at 200 chars instead of 500.

**Complexity:** Medium

---

## 3. Critical: SearchSymbol Parses All Files from Recent Commits

**File:** `app.go:558-595`

**Problem:** `SearchSymbol` has the same pattern as `SuggestSymbols` — it gets 10 commits, collects all changed files, parses each one via HTTP, then does string matching:

```go
// app.go:568-580
commits, _ := codeview.ListCommits(repo, 10, "")
for _, c := range commits {
    files, _ := codeview.GetDiffFiles(repo, c.Hash)
    for _, f := range files {
        fileSet[f.Path] = true
    }
}
for f := range fileSet {
    syms, _ := codeview.ParseFile("http://127.0.0.1:9999", filepath.Join(repo, f))
    // string matching on each symbol...
}
```

This is an N+1 pattern: N git commands + N HTTP parse calls + N file reads for code matching.

**Impact:** Seconds of latency for each keystroke in symbol search.

**Solution:**
1. **Build a symbol index** at project load time. Store `(name, kind, file, start_line, end_line)` in SQLite with FTS5 on the name column.
2. **Incremental updates:** Re-index only files that changed (use git diff or file mtime).
3. **Debounce on frontend** (already 400ms for search preview, but SearchSymbol in promptbuilder has no debounce).

**Complexity:** Medium

---

## 4. High: ListCommits Shells Out Per-Commit for File Count

**File:** `internal/service/codeview/git.go:42-46`

**Problem:** Inside the `ListCommits` loop, for every commit, there's a separate `git diff-tree` call just to count files:

```go
// git.go:42-46
fout, _ := gitCmd(repoPath, "diff-tree", "--no-commit-id", "-r", "--name-only", parts[0])
files := len(strings.Split(strings.TrimSpace(fout), "\n"))
```

For 30 commits, this is 30 extra `exec.Command("git", ...)` calls.

**Impact:** ~30 process spawns per `loadCommits` call. On Windows/WSL this is especially slow (~50ms per spawn).

**Solution:** Use `git log --stat` or `git log --numstat` in a single command to get file counts alongside commit info. Replace the format string:

```go
args := []string{"log", fmt.Sprintf("-%d", limit),
    "--pretty=format:%H|%s|%an|%at",
    "--numstat", "--no-merges"}
```

Then parse the numstat lines between commits to count files. One git process instead of 31.

**Complexity:** Low

---

## 5. High: FindGitRepos Called Repeatedly Without Caching

**File:** `internal/service/codeview/git.go:96-125`, called from `app.go` in 15+ methods

**Problem:** `FindGitRepos` does filesystem traversal (2 levels deep of `os.ReadDir` + `os.Stat` for `.git`) and is called by nearly every code viewer method:

- `ListDirectory` (line 350)
- `GetFileSymbols` (line 395)
- `GetCommits` (line 413)
- `GetBranches` (line 440)
- `GetCommitDetail` (line 470)
- `GetDiffFiles` (line 476)
- `GetFilePatch` (line 483)
- `GetSymbolGraph` (line 498)
- `SuggestSymbols` (line 494)
- `SearchSymbol` (line 564)
- `ExpandSymbol` (line 600)
- `ReadSymbolCode` (line 630)
- `ReadProjectFile` (line 380)

Each call does 1 + N + N×M `os.Stat` calls where N = subdirs, M = sub-subdirs.

**Impact:** Hundreds of redundant filesystem stat calls per user interaction.

**Solution:** Cache `FindGitRepos` results per project path with a TTL (e.g., 60 seconds) or invalidate on git operations:

```go
type repoCache struct {
    repos   []string
    expires time.Time
}
var gitRepoCache sync.Map // projectPath → *repoCache
```

**Complexity:** Low

---

## 6. High: ingestAll Embeds All New Messages Every 30s

**File:** `app.go:680-720`

**Problem:** Every 30 seconds, `ingestAll`:
1. Reads conversations from ALL active sessions (file I/O per session)
2. Queries SQLite for existing messages per session (`FindBySession`)
3. Embeds all new assistant messages via HTTP to Python sidecar

```go
// app.go:695
existing, _ := a.msgRepo.FindBySession(s.ID)
if len(msgs) <= len(existing) { continue }
newMsgs := msgs[len(existing):]
```

The `FindBySession` call loads all messages just to count them. Then `EmbedBatch` sends potentially large texts to the Python server.

**Impact:** Periodic CPU/IO spikes every 30s. With 5 active sessions, that's 5 DB queries + 5 conversation file reads + potentially expensive embedding calls.

**Solution:**
1. **Track ingestion offset** in memory (`map[sessionID]int`) instead of querying `FindBySession` each time.
2. **Increase interval** to 60s or make it adaptive (only run when sessions have new output, tracked via `LastOutputTime`).
3. **Rate-limit embedding calls:** Queue messages and batch-embed in larger groups less frequently.

**Complexity:** Low

---

## 7. High: ListDirectory Shells Out to git ls-files Per Repo

**File:** `app.go:340-370`

**Problem:** `ListDirectory` calls `git ls-files` for every git repo in the project, then builds a tracked-files map by iterating all output lines and computing parent directories:

```go
// app.go:350-365
for _, repo := range codeview.FindGitRepos(projPath) {
    out, err := exec.Command("git", "-C", repo, "ls-files", "--cached", "--others", "--exclude-standard").Output()
    // ... iterates ALL tracked files to build parent dir map
}
```

For a Spring Boot project with 500 files across 2 repos, this spawns 2 git processes and iterates 500+ paths to build the `tracked` map — every time the user expands a directory.

**Impact:** 100-500ms per directory expansion.

**Solution:**
1. **Cache the tracked map** per project with a TTL (30-60s). Invalidate on git operations.
2. **Use `.gitignore` parsing** instead of shelling out. Libraries like `go-gitignore` can check paths without spawning processes.
3. **Lazy evaluation:** Only check if a specific path is tracked when needed, not build the full map.

**Complexity:** Low-Medium

---

## 8. High: SendInput Writes Char-by-Char with Sleep

**File:** `app.go:186-197`

**Problem:** `SendInput` simulates typing by writing one character at a time with 3ms sleep between each:

```go
// app.go:190-195
for _, ch := range text {
    pty.Write(string(ch))
    time.Sleep(3 * time.Millisecond)
}
time.Sleep(10 * time.Millisecond)
pty.Write("\r")
```

For a 2000-character prompt with context injection, this takes 2000 × 3ms = **6 seconds** just to type. The mutex is held the entire time, blocking all other terminal operations.

**Impact:** 6+ seconds of blocked UI for long prompts. Mutex contention blocks `SendRaw`, `ResizeTerminal`, etc.

**Solution:**
1. **Write in chunks** (e.g., 100 chars at a time with 10ms between chunks).
2. **Release the mutex** between chunks or use per-session locks instead of a global mutex.
3. **Use PTY write buffering** — most terminals handle bulk writes fine. The char-by-char approach is only needed for specific CLI tools that have input detection.

**Complexity:** Low

---

## 9. Medium: Python Embed Server is Single-Threaded Flask

**File:** `internal/infra/embedding/embed_server.py:1-8`

**Problem:** Flask's development server is single-threaded. When `EmbedBatch` sends 300 symbol texts, the server blocks all other requests (`/parse`, `/tokenize`, `/health`) until embedding completes.

```python
# embed_server.py:130
app.run(host="127.0.0.1", port=port)
```

**Impact:** Parse requests queue behind embedding requests. Health checks timeout during long embeddings.

**Solution:**
1. **Use gunicorn/waitress** with 2-4 workers: `waitress.serve(app, host='127.0.0.1', port=port, threads=4)`
2. **Or use Flask's threaded mode:** `app.run(threaded=True)` (quick fix, but GIL limits true parallelism)
3. **Best:** Separate embedding and parsing into different endpoints/processes since they have different resource profiles (GPU vs CPU).

**Complexity:** Low

---

## 10. Medium: Bubble Sort Used for Ranking

**Files:** `internal/infra/store/message_repo.go:85-90`, `internal/infra/store/kb_repo.go:65-70`, `app.go:535-540`, `app.go:660-665`

**Problem:** All ranking/sorting uses O(n²) bubble sort:

```go
// message_repo.go:85-90
for i := range candidates {
    for j := i + 1; j < len(candidates); j++ {
        if candidates[j].final > candidates[i].final {
            candidates[i], candidates[j] = candidates[j], candidates[i]
        }
    }
}
```

This pattern appears 4 times across the codebase.

**Impact:** For 1000 candidates, that's 500K comparisons instead of ~10K with proper sorting.

**Solution:** Use `sort.Slice`:

```go
sort.Slice(candidates, func(i, j int) bool {
    return candidates[i].final > candidates[j].final
})
```

**Complexity:** Trivial

---

## 11. Medium: getProjectPath Scans All Projects Linearly

**File:** `app.go:330-337`

**Problem:** `getProjectPath` loads all projects from config and linearly scans for a name match. Called by every code viewer method.

```go
func (a *App) getProjectPath(name string) string {
    projects, _ := a.config.LoadProjects()
    for _, p := range projects {
        if p.Name == name { return p.Path }
    }
    return ""
}
```

`LoadProjects` reads and parses the JSON config file from disk on every call.

**Impact:** Redundant file I/O on every API call from the frontend.

**Solution:** Cache projects in memory. Invalidate on `SaveProjects`:

```go
type App struct {
    // ...
    projectCache map[string]string // name → path
}
```

**Complexity:** Low

---

## 12. Medium: No Embedding Cache — Same Text Re-embedded

**Files:** `app.go:488` (SuggestSymbols), `app.go:700` (ingestAll), `app.go:440` (SearchChunks)

**Problem:** The same text can be embedded multiple times:
- `SearchChunks` embeds the query on every keystroke (after 400ms debounce)
- `SuggestSymbols` embeds the same prompt + all symbol texts
- `ingestAll` may re-embed messages if the session offset tracking fails

**Impact:** Redundant HTTP calls to the Python server. Each embedding call takes 50-200ms.

**Solution:** Add an LRU cache in the embedding client:

```go
type Client struct {
    url   string
    cache *lru.Cache // hash(text) → []float32
}
```

Use a content hash (FNV or SHA256 of first 512 bytes) as key. Cache size ~1000 entries (~3MB for 768-dim vectors).

**Complexity:** Low

---

## 13. Medium: Frontend File Tree Cache Never Invalidated

**File:** `frontend/src/js/filetree.js:1-10`

**Problem:** `ftCache` stores directory listings but only resets on tab switch (`resetFileTree`). If files are created/deleted by agents, the tree is stale.

```javascript
let ftCache = {}; // path → children cache
// Only cleared in resetFileTree()
```

**Impact:** Stale file tree until user switches tabs. Confusing when agents create new files.

**Solution:**
1. Add a TTL to cache entries (e.g., 30s).
2. Listen for `pty:output` events and invalidate cache when git operations are detected (heuristic: output contains "create", "write", "delete" patterns).
3. Add a manual refresh button (simplest).

**Complexity:** Low

---

## 14. Medium: KBRepo.FindRelevant Full-Table Scan Duplicates Pattern

**File:** `internal/infra/store/kb_repo.go:30-70`

**Problem:** Identical pattern to `MessageRepo.FindRelevant` — loads all KB chunks for a project to compute cosine similarity. Same O(n) issue.

Additionally, the FTS and embedding searches are done sequentially, not in parallel.

**Solution:** Same as issue #1. Additionally, since KB chunks change less frequently than messages, a pre-computed nearest-neighbor index would be very effective here.

**Complexity:** Medium (same as #1)

---

## 15. Medium: MarkChanged Fetches Patch Per-File Redundantly

**File:** `internal/service/codeview/ast.go:130-145`

**Problem:** `MarkChanged` calls `GetFilePatch` for each unique file in the graph. But `GetSymbolGraph` (which calls `MarkChanged`) already has the file list from `GetDiffFiles`. The patches could be fetched once and reused.

```go
// ast.go:135
for _, s := range graph.Symbols {
    if _, ok := fileLines[s.File]; ok { continue }
    patch, _ := GetFilePatch(repoPath, hash, s.File)
    fileLines[s.File] = parseDiffLines(patch)
}
```

Each `GetFilePatch` spawns a `git diff` process.

**Impact:** N git processes where N = number of changed files (already fetched earlier).

**Solution:** Pass the patches from `GetDiffFiles` context or fetch all patches in a single `git diff` call (without `--` file filter).

**Complexity:** Low

---

## 16. Low: Frontend Event Listeners Not Cleaned Up on Tab Switch

**File:** `frontend/src/js/main.js:175-180`

**Problem:** `createPane` registers Wails event listeners but `killPane` only calls `EventsOff` for `pty:output` and `pty:exit`. The `tokens:update` listener is never removed:

```javascript
// main.js:175 — registered
window.runtime.EventsOn('tokens:update:' + sessionID, (info) => {
    updateTokenDisplay(sessionID, info);
});

// main.js:190 — NOT removed in killPane
```

Also, the `setInterval` for token refresh (input.js:last line) runs globally and iterates all panes every 60s, even for closed tabs.

**Impact:** Memory leak — event handlers accumulate. Minor but compounds over long sessions.

**Solution:** Add `EventsOff('tokens:update:' + sessionID)` in `killPane`. Clear the interval when no panes are open.

**Complexity:** Trivial

---

## 17. Low: ParseFile HTTP Call Per File — No Batching

**File:** `internal/service/codeview/ast.go:72-85`

**Problem:** `ParseFile` makes one HTTP POST per file. `BuildGraph`, `SuggestSymbols`, and `SearchSymbol` call it in a loop:

```go
// ast.go:93-100 (BuildGraph)
for _, f := range changedFiles {
    fullPath := filepath.Join(repoPath, f)
    syms, err := ParseFile(serverURL, fullPath)
}
```

**Impact:** N HTTP round-trips where N = number of changed files. Each has ~5ms overhead.

**Solution:** Add a `/parse_batch` endpoint to the Python server that accepts multiple file paths and returns all symbols at once.

**Complexity:** Low-Medium

---

## 18. Low: cosineSim Missing sqrt — Incorrect Results

**File:** `app.go:548-557`

**Problem:** The `cosineSim` function in `app.go` computes `dot / (na * nb)` instead of `dot / (sqrt(na) * sqrt(nb))`:

```go
// app.go:555
return dot / (na * nb)
```

Compare with the correct version in `message_repo.go:130`:
```go
return dot / (math.Sqrt(na) * math.Sqrt(nb))
```

**Impact:** Incorrect similarity scores in `SuggestSymbols`. Results are still ordered correctly (monotonic transformation) but the 0.2 threshold (line 534) filters incorrectly.

**Solution:** Fix to use `math.Sqrt`:
```go
return dot / (math.Sqrt(na) * math.Sqrt(nb))
```

**Complexity:** Trivial

---

## 19. Low: SQLite Connection Not Pooled or Configured

**File:** `internal/infra/store/db.go:14-18`

**Problem:** SQLite is opened with default settings. No connection pool configuration, no busy timeout, no PRAGMA optimizations:

```go
db, err := sql.Open("sqlite3", dbPath+"?_journal_mode=WAL")
```

Missing: `_busy_timeout`, `_synchronous`, `_cache_size`, `_mmap_size`, connection pool limits.

**Impact:** Under concurrent access (ingestAll + SearchChunks + FindRelevant), SQLite may return "database is locked" errors.

**Solution:**
```go
dsn := dbPath + "?_journal_mode=WAL&_busy_timeout=5000&_synchronous=NORMAL&_cache_size=-64000&_mmap_size=268435456"
db, err := sql.Open("sqlite3", dsn)
db.SetMaxOpenConns(1) // SQLite handles one writer at a time
db.SetMaxIdleConns(2)
```

**Complexity:** Trivial

---

## 20. Low: Token Refresh Interval Polls All Sessions

**File:** `frontend/src/js/input.js:last line`

**Problem:**
```javascript
setInterval(() => {
    Object.keys(panes).forEach(sid => refreshTokenCount(sid));
}, 60000);
```

This calls `CheckTokens` (Go → reads token cache) for every open pane every 60s, even when the feature is marked LEGACY and disabled.

**Impact:** Unnecessary Wails IPC calls. Minor.

**Solution:** Remove the interval since token compression is disabled, or gate it behind a feature flag.

**Complexity:** Trivial

---

## Prioritized Roadmap

### Phase 1: Quick Wins (1-2 days, high impact, trivial-low complexity)

| # | Issue | Impact | Effort |
|---|-------|--------|--------|
| 18 | Fix `cosineSim` missing sqrt | Correctness bug | 5 min |
| 10 | Replace bubble sort with `sort.Slice` (4 locations) | Medium | 15 min |
| 19 | Add SQLite PRAGMA optimizations | Medium | 15 min |
| 16 | Clean up `tokens:update` event listener | Low | 10 min |
| 20 | Remove legacy token polling interval | Low | 5 min |
| 4 | Merge `ListCommits` file count into single git command | High | 1 hour |
| 5 | Cache `FindGitRepos` results with TTL | High | 1 hour |
| 11 | Cache `getProjectPath` / project config in memory | Medium | 30 min |

### Phase 2: Core Performance (3-5 days, high impact, low-medium complexity)

| # | Issue | Impact | Effort |
|---|-------|--------|--------|
| 8 | Fix `SendInput` char-by-char + mutex contention | High | 2 hours |
| 6 | Optimize `ingestAll` with in-memory offset tracking | High | 2 hours |
| 7 | Cache `ListDirectory` git ls-files results | High | 3 hours |
| 9 | Switch Flask to threaded/multi-worker mode | Medium | 1 hour |
| 12 | Add LRU embedding cache in Go client | Medium | 3 hours |
| 15 | Avoid redundant `GetFilePatch` in `MarkChanged` | Medium | 1 hour |
| 13 | Add TTL or refresh button to frontend file tree cache | Medium | 1 hour |

### Phase 3: Architecture Improvements (1-2 weeks, critical impact, medium complexity)

| # | Issue | Impact | Effort |
|---|-------|--------|--------|
| 1 | Eliminate full-table scan in hybrid search (add time-window filter, then sqlite-vss) | Critical | 3-5 days |
| 14 | Same fix for KBRepo.FindRelevant | Critical | Included in #1 |
| 2 | Cache symbol embeddings + background pre-computation | Critical | 3 days |
| 3 | Build persistent symbol index with FTS5 | Critical | 2-3 days |
| 17 | Add `/parse_batch` endpoint to Python server | Low | 1 day |

### Phase 4: Future Considerations

- **Per-session mutex** instead of global `sync.Mutex` — eliminates contention between independent terminals
- **WebSocket for PTY output** instead of Wails events — reduces IPC overhead for high-throughput terminal output
- **Incremental FTS sync** — current approach inserts into FTS table separately from main table; use FTS5 content-sync (`content=messages`) to avoid manual sync
- **Embedding model quantization** — nomic-embed-text-v2-moe is large; consider ONNX quantized version for faster inference
- **Git operation batching** — many methods call multiple git commands sequentially; use `git` with combined flags or libgit2 bindings

---

## Summary of Expected Gains

| Phase | Estimated Improvement |
|-------|----------------------|
| Phase 1 | 2-5× faster commit loading, eliminates redundant filesystem scans |
| Phase 2 | 10× faster prompt sending, 50% reduction in embedding server load |
| Phase 3 | 100× faster search at scale (O(n) → O(log n)), eliminates the main scalability bottleneck |

The single highest-impact change is **Phase 1 item #4 + #5** (git operation optimization + caching) because they affect every user interaction with the code viewer. The single most important architectural change is **Phase 3 item #1** (eliminating full-table scans) because it's the only issue that gets worse over time as data accumulates.
