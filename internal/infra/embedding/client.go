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
