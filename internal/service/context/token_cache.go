package context

import (
	"crypto/md5"
	"fmt"
	"sync"
	"time"

	"github.com/jlortiz/redo/internal/domain"
	"github.com/jlortiz/redo/internal/infra/embedding"
)

// TokenCache caches token counts per session, refreshing on file change.
type TokenCache struct {
	embedder *embedding.Client
	mu       sync.RWMutex
	entries  map[string]*cacheEntry // sessionID -> entry
}

type cacheEntry struct {
	Tokens   int
	Messages int
	Hash     string // md5 of message contents
	Updated  time.Time
}

func NewTokenCache(embedder *embedding.Client) *TokenCache {
	return &TokenCache{
		embedder: embedder,
		entries:  make(map[string]*cacheEntry),
	}
}

// Update recomputes token count if messages changed (by hash).
// Returns (tokens, messages, changed).
func (tc *TokenCache) Update(sessionID string, msgs []domain.Message) (int, int, bool) {
	hash := hashMessages(msgs)

	tc.mu.RLock()
	e, ok := tc.entries[sessionID]
	tc.mu.RUnlock()

	if ok && e.Hash == hash {
		return e.Tokens, e.Messages, false
	}

	// Recompute
	total := 0
	if tc.embedder != nil && len(msgs) > 0 {
		texts := make([]string, len(msgs))
		for i, m := range msgs {
			texts[i] = m.Content
		}
		_, t, err := tc.embedder.Tokenize(texts)
		if err == nil {
			total = t
		} else {
			for _, txt := range texts {
				total += len(txt) / 4
			}
		}
	}

	tc.mu.Lock()
	tc.entries[sessionID] = &cacheEntry{
		Tokens:   total,
		Messages: len(msgs),
		Hash:     hash,
		Updated:  time.Now(),
	}
	tc.mu.Unlock()

	return total, len(msgs), true
}

// Get returns cached values without recomputing.
func (tc *TokenCache) Get(sessionID string) (int, int) {
	tc.mu.RLock()
	defer tc.mu.RUnlock()
	if e, ok := tc.entries[sessionID]; ok {
		return e.Tokens, e.Messages
	}
	return 0, 0
}

func (tc *TokenCache) Remove(sessionID string) {
	tc.mu.Lock()
	delete(tc.entries, sessionID)
	tc.mu.Unlock()
}

func hashMessages(msgs []domain.Message) string {
	h := md5.New()
	for _, m := range msgs {
		fmt.Fprintf(h, "%s:%s:%d|", m.Role, m.Content[:min(50, len(m.Content))], len(m.Content))
	}
	return fmt.Sprintf("%x", h.Sum(nil))
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
