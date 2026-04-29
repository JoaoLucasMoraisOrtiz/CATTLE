package store

import (
	"database/sql"
	"encoding/binary"
	"math"

	"github.com/jlortiz/redo/internal/domain"
)

type MessageRepo struct{ db *sql.DB }

func NewMessageRepo(db *sql.DB) *MessageRepo { return &MessageRepo{db: db} }

func (r *MessageRepo) Save(msg *domain.Message) error {
	res, err := r.db.Exec(
		`INSERT INTO messages (project, agent, session_id, role, content, embedding) VALUES (?,?,?,?,?,?)`,
		msg.Project, msg.Agent, msg.SessionID, msg.Role, msg.Content, encodeVec(msg.Embedding),
	)
	if err != nil {
		return err
	}
	// Sync FTS
	id, _ := res.LastInsertId()
	_, err = r.db.Exec(`INSERT INTO messages_fts(rowid, content) VALUES (?,?)`, id, msg.Content)
	return err
}

func (r *MessageRepo) CountBySession(sessionID string) int {
	var count int
	r.db.QueryRow(`SELECT COUNT(*) FROM messages WHERE session_id=?`, sessionID).Scan(&count)
	return count
}

func (r *MessageRepo) FindBySession(sessionID string) ([]domain.Message, error) {
	rows, err := r.db.Query(
		`SELECT id, project, agent, session_id, role, content FROM messages WHERE session_id=? ORDER BY id`, sessionID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var msgs []domain.Message
	for rows.Next() {
		var m domain.Message
		rows.Scan(&m.ID, &m.Project, &m.Agent, &m.SessionID, &m.Role, &m.Content)
		msgs = append(msgs, m)
	}
	return msgs, nil
}

// FindRelevant does hybrid search: cosine similarity + FTS5 BM25 + temporal decay.
// commitTS is the unix timestamp of the commit being investigated (0 = no decay).
func (r *MessageRepo) FindRelevant(project, query string, queryVec []float32, limit int, commitTS int64) ([]domain.Message, error) {
	// FTS5 candidates
	fq := ftsQuery(query)
	var ftsRows *sql.Rows
	if fq != "" {
		ftsRows, _ = r.db.Query(
			`SELECT m.id, m.project, m.agent, m.session_id, m.role, m.content, m.embedding, bm25(messages_fts) AS score,
			        CAST(strftime('%s', m.created_at) AS INTEGER) AS ts
			 FROM messages_fts f JOIN messages m ON f.rowid = m.id
			 WHERE m.project=? AND messages_fts MATCH ? ORDER BY score LIMIT ?`,
			project, fq, limit*3,
		)
	}

	type scored struct {
		msg   domain.Message
		bm25  float64
		cos   float64
		decay float64
		final float64
	}
	seen := map[int64]bool{}
	var candidates []scored

	if ftsRows != nil {
		defer ftsRows.Close()
		for ftsRows.Next() {
			var s scored
			var emb []byte
			var ts int64
			ftsRows.Scan(&s.msg.ID, &s.msg.Project, &s.msg.Agent, &s.msg.SessionID, &s.msg.Role, &s.msg.Content, &emb, &s.bm25, &ts)
			s.bm25 = -s.bm25
			s.msg.CreatedAt = ts
			if v := decodeVec(emb); v != nil && queryVec != nil {
				s.cos = cosine(queryVec, v)
			}
			s.decay = temporalDecay(commitTS, ts)
			candidates = append(candidates, s)
			seen[s.msg.ID] = true
		}
	}

	// Embedding-only candidates (last 90 days, with embeddings only)
	if queryVec != nil {
		allRows, _ := r.db.Query(
			`SELECT id, project, agent, session_id, role, content, embedding,
			        CAST(strftime('%s', created_at) AS INTEGER) AS ts
			 FROM messages WHERE project=? AND embedding IS NOT NULL
			 AND created_at > datetime('now', '-90 days')
			 ORDER BY created_at DESC LIMIT ?`, project, limit*5,
		)
		if allRows != nil {
			defer allRows.Close()
			for allRows.Next() {
				var m domain.Message
				var emb []byte
				var ts int64
				allRows.Scan(&m.ID, &m.Project, &m.Agent, &m.SessionID, &m.Role, &m.Content, &emb, &ts)
				if seen[m.ID] {
					continue
				}
				m.CreatedAt = ts
				if v := decodeVec(emb); v != nil {
					cos := cosine(queryVec, v)
					if cos > 0.3 {
						candidates = append(candidates, scored{msg: m, cos: cos, decay: temporalDecay(commitTS, ts)})
					}
				}
			}
		}
	}

	// Normalize + combine: α=0.4 semantic, β=0.2 keyword, γ=0.4 temporal
	maxBM, maxCos := 0.0, 0.0
	for _, c := range candidates {
		if c.bm25 > maxBM { maxBM = c.bm25 }
		if c.cos > maxCos { maxCos = c.cos }
	}
	for i := range candidates {
		nb, nc := 0.0, 0.0
		if maxBM > 0 { nb = candidates[i].bm25 / maxBM }
		if maxCos > 0 { nc = candidates[i].cos / maxCos }
		candidates[i].final = 0.4*nc + 0.2*nb + 0.4*candidates[i].decay
	}
	// Sort desc
	for i := range candidates {
		for j := i + 1; j < len(candidates); j++ {
			if candidates[j].final > candidates[i].final {
				candidates[i], candidates[j] = candidates[j], candidates[i]
			}
		}
	}

	var result []domain.Message
	for i, c := range candidates {
		if i >= limit { break }
		result = append(result, c.msg)
	}
	return result, nil
}

// temporalDecay returns a score [0,1] based on how close a message is to a commit.
// exp(-λ * |days|) where λ = 0.1
// Same day: ~1.0, same week: ~0.5, same month: ~0.05, no commitTS: 0.5 (neutral)
func temporalDecay(commitTS, msgTS int64) float64 {
	if commitTS == 0 || msgTS == 0 {
		return 0.5 // neutral when no timestamp
	}
	days := math.Abs(float64(commitTS-msgTS)) / 86400.0
	return math.Exp(-0.1 * days)
}

func (r *MessageRepo) SaveSummary(project, agent, sessionID, content string, msgCount int) error {
	_, err := r.db.Exec(
		`INSERT INTO summaries (project, agent, session_id, content, msg_count) VALUES (?,?,?,?,?)`,
		project, agent, sessionID, content, msgCount,
	)
	return err
}

func (r *MessageRepo) GetLatestSummary(project, sessionID string) (string, error) {
	var content string
	err := r.db.QueryRow(
		`SELECT content FROM summaries WHERE project=? AND session_id=? ORDER BY id DESC LIMIT 1`,
		project, sessionID,
	).Scan(&content)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return content, err
}

// --- vector helpers ---

func encodeVec(v []float32) []byte {
	if v == nil { return nil }
	buf := make([]byte, len(v)*4)
	for i, f := range v {
		binary.LittleEndian.PutUint32(buf[i*4:], math.Float32bits(f))
	}
	return buf
}

func decodeVec(b []byte) []float32 {
	if len(b) < 4 { return nil }
	v := make([]float32, len(b)/4)
	for i := range v {
		v[i] = math.Float32frombits(binary.LittleEndian.Uint32(b[i*4:]))
	}
	return v
}

func cosine(a, b []float32) float64 {
	if len(a) != len(b) { return 0 }
	var dot, na, nb float64
	for i := range a {
		dot += float64(a[i]) * float64(b[i])
		na += float64(a[i]) * float64(a[i])
		nb += float64(b[i]) * float64(b[i])
	}
	if na == 0 || nb == 0 { return 0 }
	return dot / (math.Sqrt(na) * math.Sqrt(nb))
}
