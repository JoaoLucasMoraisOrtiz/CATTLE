package embedding

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// Client calls the embedding server's /embed endpoint.
type Client struct {
	url string
}

func NewClient(baseURL string) *Client {
	if baseURL == "" {
		baseURL = "http://127.0.0.1:9999"
	}
	return &Client{url: baseURL}
}

func (c *Client) Embed(text string) ([]float32, error) {
	vecs, err := c.EmbedBatch([]string{text})
	if err != nil {
		return nil, err
	}
	return vecs[0], nil
}

func (c *Client) EmbedBatch(texts []string) ([][]float32, error) {
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
