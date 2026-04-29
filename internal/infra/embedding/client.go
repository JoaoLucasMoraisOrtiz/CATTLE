package embedding

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
)

// Client calls the embedding server's /embed endpoint.
type Client struct {
	url   string
	cache map[string][]float32
	mu    sync.RWMutex
}

func NewClient(baseURL string) *Client {
	if baseURL == "" {
		baseURL = "http://127.0.0.1:9999"
	}
	return &Client{url: baseURL, cache: make(map[string][]float32)}
}

func textHash(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:8]) // 16 char hex, enough for dedup
}

func (c *Client) Embed(text string) ([]float32, error) {
	key := textHash(text)
	c.mu.RLock()
	if v, ok := c.cache[key]; ok {
		c.mu.RUnlock()
		return v, nil
	}
	c.mu.RUnlock()

	vecs, err := c.embedRemote([]string{text})
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	c.cache[key] = vecs[0]
	// Evict if cache too large (>5000 entries)
	if len(c.cache) > 5000 {
		i := 0
		for k := range c.cache {
			if i > 500 { break }
			delete(c.cache, k)
			i++
		}
	}
	c.mu.Unlock()
	return vecs[0], nil
}

func (c *Client) EmbedBatch(texts []string) ([][]float32, error) {
	results := make([][]float32, len(texts))
	var uncached []string
	var uncachedIdx []int

	c.mu.RLock()
	for i, t := range texts {
		key := textHash(t)
		if v, ok := c.cache[key]; ok {
			results[i] = v
		} else {
			uncached = append(uncached, t)
			uncachedIdx = append(uncachedIdx, i)
		}
	}
	c.mu.RUnlock()

	if len(uncached) == 0 {
		return results, nil
	}

	vecs, err := c.embedRemote(uncached)
	if err != nil {
		return nil, err
	}

	c.mu.Lock()
	for j, idx := range uncachedIdx {
		results[idx] = vecs[j]
		c.cache[textHash(uncached[j])] = vecs[j]
	}
	c.mu.Unlock()
	return results, nil
}

func (c *Client) embedRemote(texts []string) ([][]float32, error) {
	body, _ := json.Marshal(map[string]any{"texts": texts})
	resp, err := http.Post(c.url+"/embed", "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("embed request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("embed %d: %s", resp.StatusCode, b)
	}

	var result struct {
		Embeddings [][]float32 `json:"embeddings"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("embed decode: %w", err)
	}
	if len(result.Embeddings) != len(texts) {
		return nil, fmt.Errorf("expected %d embeddings, got %d", len(texts), len(result.Embeddings))
	}
	return result.Embeddings, nil
}

// Tokenize returns token counts for each text and the total.
func (c *Client) Tokenize(texts []string) ([]int, int, error) {
	body, _ := json.Marshal(map[string]any{"texts": texts})
	resp, err := http.Post(c.url+"/tokenize", "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	var result struct {
		Counts []int `json:"counts"`
		Total  int   `json:"total"`
	}
	json.NewDecoder(resp.Body).Decode(&result)
	return result.Counts, result.Total, nil
}

// Summarize compresses messages into a summary via LLM.
func (c *Client) Summarize(messages []map[string]string, geminiKey string, maxTokens int) (string, error) {
	body, _ := json.Marshal(map[string]any{
		"messages":   messages,
		"gemini_key": geminiKey,
		"max_tokens": maxTokens,
	})
	resp, err := http.Post(c.url+"/summarize", "application/json", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var result struct {
		Summary string `json:"summary"`
	}
	json.NewDecoder(resp.Body).Decode(&result)
	return result.Summary, nil
}
