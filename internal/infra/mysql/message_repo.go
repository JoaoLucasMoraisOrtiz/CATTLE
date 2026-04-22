package mysql

import (
	"database/sql"
	"encoding/binary"
	"math"

	"github.com/jlortiz/redo/internal/domain"
)

type MessageRepo struct{ db *sql.DB }

func NewMessageRepo(db *sql.DB) *MessageRepo { return &MessageRepo{db: db} }

func (r *MessageRepo) Save(msg *domain.Message) error {
	_, err := r.db.Exec(
		`INSERT INTO messages (project, agent, session_id, role, content, embedding) VALUES (?,?,?,?,?,?)`,
		msg.Project, msg.Agent, msg.SessionID, msg.Role, msg.Content, encodeVec(msg.Embedding),
	)
	return err
}

func (r *MessageRepo) FindBySession(sessionID string) ([]domain.Message, error) {
	rows, err := r.db.Query(
		`SELECT id, project, agent, session_id, role, content FROM messages WHERE session_id=? ORDER BY id`,
		sessionID,
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

// FindRelevant does hybrid search: cosine similarity on embeddings + FULLTEXT on content.
// α=0.6 for semantic, 0.4 for keyword.
func (r *MessageRepo) FindRelevant(project string, query string, queryVec []float32, limit int) ([]domain.Message, error) {
	// Step 1: FULLTEXT candidates
	rows, err := r.db.Query(
		`SELECT id, project, agent, session_id, role, content, embedding,
		        MATCH(content) AGAINST(? IN NATURAL LANGUAGE MODE) AS ft_score
		 FROM messages
		 WHERE project=? AND MATCH(content) AGAINST(? IN NATURAL LANGUAGE MODE)
		 ORDER BY ft_score DESC LIMIT ?`,
		query, project, query, limit*3,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	type scored struct {
		msg     domain.Message
		ftScore float64
		cosine  float64
	}
	var candidates []scored
	for rows.Next() {
		var s scored
		var embBlob []byte
		var ft float64
		rows.Scan(&s.msg.ID, &s.msg.Project, &s.msg.Agent, &s.msg.SessionID, &s.msg.Role, &s.msg.Content, &embBlob, &ft)
		s.ftScore = ft
		if vec := decodeVec(embBlob); vec != nil && queryVec != nil {
			s.cosine = cosine(queryVec, vec)
		}
		candidates = append(candidates, s)
	}

	// Step 2: also get top embedding matches (may not overlap with FULLTEXT)
	allRows, err := r.db.Query(
		`SELECT id, project, agent, session_id, role, content, embedding FROM messages WHERE project=?`,
		project,
	)
	if err == nil {
		defer allRows.Close()
		seen := map[int64]bool{}
		for _, c := range candidates {
			seen[c.msg.ID] = true
		}
		for allRows.Next() {
			var m domain.Message
			var embBlob []byte
			allRows.Scan(&m.ID, &m.Project, &m.Agent, &m.SessionID, &m.Role, &m.Content, &embBlob)
			if seen[m.ID] {
				continue
			}
			if vec := decodeVec(embBlob); vec != nil && queryVec != nil {
				cos := cosine(queryVec, vec)
				if cos > 0.3 { // threshold
					candidates = append(candidates, scored{msg: m, cosine: cos})
				}
			}
		}
	}

	// Step 3: normalize and combine scores
	maxFT := 0.0
	maxCos := 0.0
	for _, c := range candidates {
		if c.ftScore > maxFT {
			maxFT = c.ftScore
		}
		if c.cosine > maxCos {
			maxCos = c.cosine
		}
	}

	const alpha = 0.6
	for i := range candidates {
		normFT := 0.0
		normCos := 0.0
		if maxFT > 0 {
			normFT = candidates[i].ftScore / maxFT
		}
		if maxCos > 0 {
			normCos = candidates[i].cosine / maxCos
		}
		candidates[i].cosine = alpha*normCos + (1-alpha)*normFT // reuse field for final score
	}

	// Sort by combined score desc
	for i := range candidates {
		for j := i + 1; j < len(candidates); j++ {
			if candidates[j].cosine > candidates[i].cosine {
				candidates[i], candidates[j] = candidates[j], candidates[i]
			}
		}
	}

	var result []domain.Message
	for i, c := range candidates {
		if i >= limit {
			break
		}
		result = append(result, c.msg)
	}
	return result, nil
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
	if v == nil {
		return nil
	}
	buf := make([]byte, len(v)*4)
	for i, f := range v {
		binary.LittleEndian.PutUint32(buf[i*4:], math.Float32bits(f))
	}
	return buf
}

func decodeVec(b []byte) []float32 {
	if len(b) < 4 {
		return nil
	}
	v := make([]float32, len(b)/4)
	for i := range v {
		v[i] = math.Float32frombits(binary.LittleEndian.Uint32(b[i*4:]))
	}
	return v
}

func cosine(a, b []float32) float64 {
	if len(a) != len(b) {
		return 0
	}
	var dot, na, nb float64
	for i := range a {
		dot += float64(a[i]) * float64(b[i])
		na += float64(a[i]) * float64(a[i])
		nb += float64(b[i]) * float64(b[i])
	}
	if na == 0 || nb == 0 {
		return 0
	}
	return dot / (math.Sqrt(na) * math.Sqrt(nb))
}
