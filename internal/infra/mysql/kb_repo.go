package mysql

import (
	"database/sql"

	"github.com/jlortiz/redo/internal/domain"
)

type KBRepo struct{ db *sql.DB }

func NewKBRepo(db *sql.DB) *KBRepo { return &KBRepo{db: db} }

func (r *KBRepo) SaveChunk(chunk *domain.KBChunk) error {
	_, err := r.db.Exec(
		`INSERT INTO kb_chunks (project, source_file, chunk_index, content, embedding) VALUES (?,?,?,?,?)`,
		chunk.Project, chunk.SourceFile, chunk.ChunkIndex, chunk.Content, encodeVec(chunk.Embedding),
	)
	return err
}

func (r *KBRepo) FindRelevant(project, query string, queryVec []float32, limit int) ([]domain.KBChunk, error) {
	rows, err := r.db.Query(
		`SELECT id, project, source_file, chunk_index, content, embedding,
		        MATCH(content) AGAINST(? IN NATURAL LANGUAGE MODE) AS ft_score
		 FROM kb_chunks WHERE project=?
		 ORDER BY ft_score DESC LIMIT ?`,
		query, project, limit*3,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	type scored struct {
		chunk   domain.KBChunk
		ftScore float64
		cosine  float64
	}
	var candidates []scored
	for rows.Next() {
		var s scored
		var embBlob []byte
		rows.Scan(&s.chunk.ID, &s.chunk.Project, &s.chunk.SourceFile, &s.chunk.ChunkIndex, &s.chunk.Content, &embBlob, &s.ftScore)
		if vec := decodeVec(embBlob); vec != nil && queryVec != nil {
			s.cosine = cosine(queryVec, vec)
		}
		candidates = append(candidates, s)
	}

	// Normalize + combine (α=0.6 semantic, 0.4 keyword)
	maxFT, maxCos := 0.0, 0.0
	for _, c := range candidates {
		if c.ftScore > maxFT { maxFT = c.ftScore }
		if c.cosine > maxCos { maxCos = c.cosine }
	}
	for i := range candidates {
		nf, nc := 0.0, 0.0
		if maxFT > 0 { nf = candidates[i].ftScore / maxFT }
		if maxCos > 0 { nc = candidates[i].cosine / maxCos }
		candidates[i].cosine = 0.6*nc + 0.4*nf
	}
	for i := range candidates {
		for j := i + 1; j < len(candidates); j++ {
			if candidates[j].cosine > candidates[i].cosine {
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
