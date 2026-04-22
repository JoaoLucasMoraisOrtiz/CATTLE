package kb

import (
	"fmt"
	"os"
	"strings"

	"github.com/jlortiz/redo/internal/domain"
	"github.com/jlortiz/redo/internal/infra/embedding"
	"github.com/jlortiz/redo/internal/infra/store"
)

const (
	chunkSize = 1500 // chars per chunk
	overlap   = 200  // chars overlap between chunks
)

// Ingest reads a file, chunks it, embeds, and saves to SQLite.
func Ingest(repo *store.KBRepo, embedder *embedding.Client, project, filePath string) (int, error) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return 0, err
	}

	repo.DeleteBySource(project, filePath)

	chunks := Chunk(string(data))
	if len(chunks) == 0 {
		return 0, nil
	}

	vecs, err := embedder.EmbedBatch(chunks)
	if err != nil {
		fmt.Printf("[KB] embed error: %v (saving without embeddings)\n", err)
		vecs = make([][]float32, len(chunks))
	}

	for i, text := range chunks {
		c := &domain.KBChunk{
			Project:    project,
			SourceFile: filePath,
			ChunkIndex: i,
			Content:    text,
			Embedding:  vecs[i],
		}
		if err := repo.SaveChunk(c); err != nil {
			return i, fmt.Errorf("save chunk %d: %w", i, err)
		}
	}
	return len(chunks), nil
}

// Chunk splits text by markdown headers first, then by paragraphs, with overlap.
func Chunk(text string) []string {
	sections := splitByHeaders(text)

	var chunks []string
	for _, sec := range sections {
		chunks = append(chunks, chunkSection(sec)...)
	}

	// Add overlap
	if overlap > 0 && len(chunks) > 1 {
		for i := 1; i < len(chunks); i++ {
			prev := chunks[i-1]
			if len(prev) > overlap {
				tail := prev[len(prev)-overlap:]
				// Cut at first newline to avoid mid-line overlap
				if idx := strings.Index(tail, "\n"); idx >= 0 {
					tail = tail[idx+1:]
				}
				if tail != "" {
					chunks[i] = tail + "\n---\n" + chunks[i]
				}
			}
		}
	}
	return chunks
}

// splitByHeaders splits markdown text at # headers, keeping the header with its content.
func splitByHeaders(text string) []string {
	lines := strings.Split(text, "\n")
	var sections []string
	var current strings.Builder

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "#") && current.Len() > 0 {
			sections = append(sections, current.String())
			current.Reset()
		}
		if current.Len() > 0 {
			current.WriteByte('\n')
		}
		current.WriteString(line)
	}
	if current.Len() > 0 {
		sections = append(sections, current.String())
	}
	return sections
}

// chunkSection splits a section into chunks of ~chunkSize by paragraphs.
func chunkSection(text string) []string {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	if len(text) <= chunkSize {
		return []string{text}
	}

	paragraphs := strings.Split(text, "\n\n")
	var chunks []string
	var current strings.Builder

	for _, p := range paragraphs {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if current.Len()+len(p) > chunkSize && current.Len() > 0 {
			chunks = append(chunks, current.String())
			current.Reset()
		}
		// Paragraph bigger than chunkSize — split by sentences
		if len(p) > chunkSize && current.Len() == 0 {
			chunks = append(chunks, splitLong(p)...)
			continue
		}
		if current.Len() > 0 {
			current.WriteString("\n\n")
		}
		current.WriteString(p)
	}
	if current.Len() > 0 {
		chunks = append(chunks, current.String())
	}
	return chunks
}

// splitLong breaks a long paragraph into chunks at sentence boundaries.
func splitLong(text string) []string {
	var chunks []string
	for len(text) > chunkSize {
		cut := chunkSize
		// Try to cut at sentence end (. ! ?)
		for i := cut; i > chunkSize/2; i-- {
			if text[i] == '.' || text[i] == '!' || text[i] == '?' {
				cut = i + 1
				break
			}
		}
		chunks = append(chunks, strings.TrimSpace(text[:cut]))
		text = strings.TrimSpace(text[cut:])
	}
	if text != "" {
		chunks = append(chunks, text)
	}
	return chunks
}
