package store

import (
	"database/sql"

	"github.com/jlortiz/redo/internal/domain"
)

type KBRepo struct{ db *sql.DB }

func NewKBRepo(db *sql.DB) *KBRepo { return &KBRepo{db: db} }

func (r *KBRepo) SaveChunk(chunk *domain.KBChunk) error {
	res, err := r.db.Exec(
		`INSERT INTO kb_chunks (project, source_file, chunk_index, content, embedding) VALUES (?,?,?,?,?)`,
		chunk.Project, chunk.SourceFile, chunk.ChunkIndex, chunk.Content, encodeVec(chunk.Embedding),
	)
	if err != nil {
		return err
	}
	id, _ := res.LastInsertId()
	_, err = r.db.Exec(`INSERT INTO kb_fts(rowid, content) VALUES (?,?)`, id, chunk.Content)
	return err
}

func (r *KBRepo) FindRelevant(project, query string, queryVec []float32, limit int) ([]domain.KBChunk, error) {
	fq := ftsQuery(query)
	var rows *sql.Rows
	if fq != "" {
		rows, _ = r.db.Query(
			`SELECT k.id, k.project, k.source_file, k.chunk_index, k.content, k.embedding, bm25(kb_fts) AS score
			 FROM kb_fts f JOIN kb_chunks k ON f.rowid = k.id
			 WHERE k.project=? AND kb_fts MATCH ? ORDER BY score LIMIT ?`,
			project, fq, limit*3,
		)
	}

	type scored struct {
		chunk domain.KBChunk
		bm25  float64
		cos   float64
		final float64
	}
	var candidates []scored
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var s scored
			var emb []byte
			rows.Scan(&s.chunk.ID, &s.chunk.Project, &s.chunk.SourceFile, &s.chunk.ChunkIndex, &s.chunk.Content, &emb, &s.bm25)
			s.bm25 = -s.bm25
			if v := decodeVec(emb); v != nil && queryVec != nil {
				s.cos = cosine(queryVec, v)
			}
			candidates = append(candidates, s)
		}
	}

	maxBM, maxCos := 0.0, 0.0
	for _, c := range candidates {
		if c.bm25 > maxBM { maxBM = c.bm25 }
		if c.cos > maxCos { maxCos = c.cos }
	}
	for i := range candidates {
		nb, nc := 0.0, 0.0
		if maxBM > 0 { nb = candidates[i].bm25 / maxBM }
		if maxCos > 0 { nc = candidates[i].cos / maxCos }
		candidates[i].final = 0.6*nc + 0.4*nb
	}
	for i := range candidates {
		for j := i + 1; j < len(candidates); j++ {
			if candidates[j].final > candidates[i].final {
				candidates[i], candidates[j] = candidates[j], candidates[i]
			}
		}
	}

	var result []domain.KBChunk
	for i, c := range candidates {
		if i >= limit { break }
		result = append(result, c.chunk)
	}
	return result, nil
}

func (r *KBRepo) DeleteBySource(project, sourceFile string) error {
	// Delete FTS entries first
	r.db.Exec(`DELETE FROM kb_fts WHERE rowid IN (SELECT id FROM kb_chunks WHERE project=? AND source_file=?)`, project, sourceFile)
	_, err := r.db.Exec(`DELETE FROM kb_chunks WHERE project=? AND source_file=?`, project, sourceFile)
	return err
}

func (r *KBRepo) GetChunksBySource(project, sourceFile string) ([]domain.KBChunk, error) {
	rows, err := r.db.Query(
		`SELECT id, project, source_file, chunk_index, content FROM kb_chunks WHERE project=? AND source_file=? ORDER BY chunk_index`,
		project, sourceFile,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var chunks []domain.KBChunk
	for rows.Next() {
		var c domain.KBChunk
		rows.Scan(&c.ID, &c.Project, &c.SourceFile, &c.ChunkIndex, &c.Content)
		chunks = append(chunks, c)
	}
	return chunks, nil
}
