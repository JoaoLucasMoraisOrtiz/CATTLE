package store

import (
	"database/sql"
	"math"
	"os"
	"testing"

	"github.com/jlortiz/redo/internal/domain"
	_ "github.com/mattn/go-sqlite3"
)

func setupTestDB(t *testing.T) (*sql.DB, func()) {
	t.Helper()
	f, err := os.CreateTemp("", "redo-test-*.db")
	if err != nil {
		t.Fatal(err)
	}
	f.Close()

	db, err := sql.Open("sqlite3", f.Name()+"?_journal_mode=WAL")
	if err != nil {
		t.Fatal(err)
	}
	if err := Migrate(db); err != nil {
		t.Fatal(err)
	}
	return db, func() { db.Close(); os.Remove(f.Name()) }
}

func TestMessageRepo_SaveAndFind(t *testing.T) {
	db, cleanup := setupTestDB(t)
	defer cleanup()
	repo := NewMessageRepo(db)

	msg := &domain.Message{
		Project:   "test-proj",
		Agent:     "kiro",
		SessionID: "sess-1",
		Role:      "assistant",
		Content:   "implemented the authentication service with JWT tokens",
	}
	if err := repo.Save(msg); err != nil {
		t.Fatal(err)
	}

	msgs, err := repo.FindBySession("sess-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	if msgs[0].Content != msg.Content {
		t.Errorf("content mismatch: %q", msgs[0].Content)
	}
}

func TestMessageRepo_FindRelevant_FTS(t *testing.T) {
	db, cleanup := setupTestDB(t)
	defer cleanup()
	repo := NewMessageRepo(db)

	messages := []domain.Message{
		{Project: "proj", Agent: "kiro", SessionID: "s1", Role: "assistant", Content: "fixed the login bug in AuthController"},
		{Project: "proj", Agent: "kiro", SessionID: "s1", Role: "assistant", Content: "refactored the payment service"},
		{Project: "proj", Agent: "kiro", SessionID: "s1", Role: "assistant", Content: "updated CSS styles for the dashboard"},
	}
	for i := range messages {
		if err := repo.Save(&messages[i]); err != nil {
			t.Fatal(err)
		}
	}

	results, err := repo.FindRelevant("proj", "login AuthController", nil, 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) == 0 {
		t.Fatal("expected FTS results for 'login AuthController'")
	}
	if results[0].Content != messages[0].Content {
		t.Errorf("expected login message first, got: %q", results[0].Content)
	}
}

func TestKBRepo_SaveAndFind(t *testing.T) {
	db, cleanup := setupTestDB(t)
	defer cleanup()
	repo := NewKBRepo(db)

	chunk := &domain.KBChunk{
		Project:    "test-proj",
		SourceFile: "docs/arch.md",
		Content:    "The system uses a microservices architecture with Spring Boot",
		ChunkIndex: 0,
	}
	if err := repo.SaveChunk(chunk); err != nil {
		t.Fatal(err)
	}

	chunks, err := repo.FindRelevant("test-proj", "microservices Spring", nil, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(chunks) == 0 {
		t.Fatal("expected FTS results for 'microservices Spring'")
	}
	if chunks[0].Content != chunk.Content {
		t.Errorf("content mismatch: %q", chunks[0].Content)
	}
}

func TestKBRepo_DeleteBySource(t *testing.T) {
	db, cleanup := setupTestDB(t)
	defer cleanup()
	repo := NewKBRepo(db)

	for i := 0; i < 3; i++ {
		repo.SaveChunk(&domain.KBChunk{
			Project: "proj", SourceFile: "docs/api.md", Content: "chunk content", ChunkIndex: i,
		})
	}
	repo.SaveChunk(&domain.KBChunk{
		Project: "proj", SourceFile: "docs/other.md", Content: "other content", ChunkIndex: 0,
	})

	if err := repo.DeleteBySource("proj", "docs/api.md"); err != nil {
		t.Fatal(err)
	}

	// api.md chunks should be gone
	results, _ := repo.FindRelevant("proj", "chunk content", nil, 10)
	for _, r := range results {
		if r.SourceFile == "docs/api.md" {
			t.Error("api.md chunks should have been deleted")
		}
	}
}

func TestCosine(t *testing.T) {
	// Identical vectors → 1.0
	a := []float32{1, 0, 0}
	b := []float32{1, 0, 0}
	if c := cosine(a, b); math.Abs(c-1.0) > 0.001 {
		t.Errorf("identical vectors: expected ~1.0, got %f", c)
	}

	// Orthogonal → 0.0
	a = []float32{1, 0, 0}
	b = []float32{0, 1, 0}
	if c := cosine(a, b); math.Abs(c) > 0.001 {
		t.Errorf("orthogonal vectors: expected ~0.0, got %f", c)
	}

	// Opposite → -1.0
	a = []float32{1, 0, 0}
	b = []float32{-1, 0, 0}
	if c := cosine(a, b); math.Abs(c+1.0) > 0.001 {
		t.Errorf("opposite vectors: expected ~-1.0, got %f", c)
	}

	// Zero vector → 0.0
	a = []float32{0, 0, 0}
	b = []float32{1, 2, 3}
	if c := cosine(a, b); c != 0 {
		t.Errorf("zero vector: expected 0, got %f", c)
	}

	// Different lengths → 0.0
	if c := cosine([]float32{1, 2}, []float32{1, 2, 3}); c != 0 {
		t.Errorf("different lengths: expected 0, got %f", c)
	}
}

func TestTemporalDecay(t *testing.T) {
	now := int64(1700000000)

	// Same timestamp → ~1.0
	d := temporalDecay(now, now)
	if math.Abs(d-1.0) > 0.01 {
		t.Errorf("same time: expected ~1.0, got %f", d)
	}

	// 1 day apart → ~0.9
	d = temporalDecay(now, now-86400)
	if d < 0.85 || d > 0.95 {
		t.Errorf("1 day: expected ~0.9, got %f", d)
	}

	// 7 days → ~0.5
	d = temporalDecay(now, now-7*86400)
	if d < 0.4 || d > 0.6 {
		t.Errorf("7 days: expected ~0.5, got %f", d)
	}

	// 30 days → ~0.05
	d = temporalDecay(now, now-30*86400)
	if d > 0.1 {
		t.Errorf("30 days: expected <0.1, got %f", d)
	}

	// No timestamp → 0.5 (neutral)
	d = temporalDecay(0, now)
	if math.Abs(d-0.5) > 0.01 {
		t.Errorf("no commit TS: expected 0.5, got %f", d)
	}
	d = temporalDecay(now, 0)
	if math.Abs(d-0.5) > 0.01 {
		t.Errorf("no msg TS: expected 0.5, got %f", d)
	}
}

func TestEncodeDecodeVec(t *testing.T) {
	original := []float32{0.1, -0.5, 3.14, 0, -1.0}
	encoded := encodeVec(original)
	decoded := decodeVec(encoded)

	if len(decoded) != len(original) {
		t.Fatalf("length mismatch: %d vs %d", len(decoded), len(original))
	}
	for i := range original {
		if math.Abs(float64(decoded[i]-original[i])) > 0.0001 {
			t.Errorf("index %d: expected %f, got %f", i, original[i], decoded[i])
		}
	}

	// Nil → nil
	if encodeVec(nil) != nil {
		t.Error("encodeVec(nil) should return nil")
	}
	if decodeVec(nil) != nil {
		t.Error("decodeVec(nil) should return nil")
	}
}
