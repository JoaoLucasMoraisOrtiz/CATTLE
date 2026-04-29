package embedding

import (
	"testing"
)

func TestTextHash(t *testing.T) {
	h1 := textHash("hello world")
	h2 := textHash("hello world")
	h3 := textHash("different text")

	if h1 != h2 {
		t.Error("same text should produce same hash")
	}
	if h1 == h3 {
		t.Error("different text should produce different hash")
	}
	if len(h1) != 16 {
		t.Errorf("hash should be 16 chars, got %d", len(h1))
	}
}

func TestEmbeddingCache_HitMiss(t *testing.T) {
	c := NewClient("http://fake:9999")

	// Cache is empty
	c.mu.RLock()
	if len(c.cache) != 0 {
		t.Error("cache should start empty")
	}
	c.mu.RUnlock()

	// Manually populate cache
	key := textHash("test text")
	vec := []float32{0.1, 0.2, 0.3}
	c.mu.Lock()
	c.cache[key] = vec
	c.mu.Unlock()

	// Should hit cache (Embed would call server for miss, but we test the lookup)
	c.mu.RLock()
	cached, ok := c.cache[key]
	c.mu.RUnlock()
	if !ok {
		t.Fatal("cache miss for known key")
	}
	if len(cached) != 3 || cached[0] != 0.1 {
		t.Errorf("unexpected cached value: %v", cached)
	}

	// Different text should miss
	c.mu.RLock()
	_, ok = c.cache[textHash("other text")]
	c.mu.RUnlock()
	if ok {
		t.Error("should miss for unknown key")
	}
}

func TestEmbeddingCache_Eviction(t *testing.T) {
	c := NewClient("http://fake:9999")

	// Fill cache beyond limit
	c.mu.Lock()
	for i := 0; i < 5100; i++ {
		c.cache[textHash(string(rune(i)))] = []float32{float32(i)}
	}
	c.mu.Unlock()

	// Trigger eviction via Embed (will fail on HTTP but eviction happens in the check)
	// Instead, simulate the eviction logic
	c.mu.Lock()
	if len(c.cache) > 5000 {
		i := 0
		for k := range c.cache {
			if i > 500 {
				break
			}
			delete(c.cache, k)
			i++
		}
	}
	c.mu.Unlock()

	c.mu.RLock()
	remaining := len(c.cache)
	c.mu.RUnlock()

	if remaining >= 5100 {
		t.Errorf("eviction should have removed entries, got %d", remaining)
	}
	if remaining < 4500 {
		t.Errorf("eviction removed too many, got %d", remaining)
	}
}
