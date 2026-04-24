// LEGACY: Context compression module. Disabled because destroying cached tokens
// is more expensive than keeping them. Providers charge much less for cached vs new tokens.
// Kept for potential future use if context windows become a bottleneck.

package context

import (
	"fmt"
	"strings"

	"github.com/jlortiz/redo/internal/domain"
	"github.com/jlortiz/redo/internal/infra/embedding"
	"github.com/jlortiz/redo/internal/infra/store"
)

const (
	TokenThreshold = 8000 // trigger compression at this point
	KeepTokens     = 5000 // keep top relevant messages up to this budget
	SummaryTokens  = 500  // max tokens for the summary
)

// Optimizer handles context compression and injection.
type Optimizer struct {
	embedder *embedding.Client
	msgRepo  *store.MessageRepo
	kbRepo   *store.KBRepo
}

func NewOptimizer(embedder *embedding.Client, msgRepo *store.MessageRepo, kbRepo *store.KBRepo) *Optimizer {
	return &Optimizer{embedder: embedder, msgRepo: msgRepo, kbRepo: kbRepo}
}

// NeedsCompression checks if a conversation exceeds the token threshold.
func (o *Optimizer) NeedsCompression(msgs []domain.Message) (bool, int) {
	if o.embedder == nil || len(msgs) == 0 {
		return false, 0
	}
	texts := make([]string, len(msgs))
	for i, m := range msgs {
		texts[i] = m.Content
	}
	_, total, err := o.embedder.Tokenize(texts)
	if err != nil {
		// Fallback: estimate 1 token ≈ 4 chars
		total = 0
		for _, t := range texts {
			total += len(t) / 4
		}
	}
	return total > TokenThreshold, total
}

// Compress splits messages into kept (top relevant) + summary of the rest.
// Returns the compressed context as a single string to inject.
func (o *Optimizer) Compress(msgs []domain.Message, currentQuery, geminiKey string) (string, error) {
	if len(msgs) == 0 {
		return "", nil
	}

	// 1. Tokenize all messages
	texts := make([]string, len(msgs))
	for i, m := range msgs {
		texts[i] = m.Content
	}
	counts, _, _ := o.embedder.Tokenize(texts)
	if len(counts) != len(msgs) {
		// Fallback
		counts = make([]int, len(msgs))
		for i, t := range texts {
			counts[i] = len(t) / 4
		}
	}

	// 2. Embed current query and rank messages by relevance
	type ranked struct {
		idx    int
		msg    domain.Message
		tokens int
		score  float64
	}
	items := make([]ranked, len(msgs))
	for i, m := range msgs {
		items[i] = ranked{idx: i, msg: m, tokens: counts[i]}
	}

	// Always keep last 3 messages (recency)
	alwaysKeep := map[int]bool{}
	for i := len(msgs) - 1; i >= 0 && i >= len(msgs)-3; i-- {
		alwaysKeep[i] = true
	}

	// Score by embedding similarity to current query
	if currentQuery != "" && o.embedder != nil {
		queryVec, err := o.embedder.Embed(currentQuery)
		if err == nil {
			msgVecs, err := o.embedder.EmbedBatch(texts)
			if err == nil {
				for i := range items {
					items[i].score = cosine(queryVec, msgVecs[i])
				}
			}
		}
	}

	// 3. Sort by score desc (but always-keep items get max score)
	for i := range items {
		if alwaysKeep[items[i].idx] {
			items[i].score = 999
		}
	}
	// Sort desc by score
	for i := range items {
		for j := i + 1; j < len(items); j++ {
			if items[j].score > items[i].score {
				items[i], items[j] = items[j], items[i]
			}
		}
	}

	// 4. Split: keep top messages within KeepTokens budget, rest goes to summary
	var kept []ranked
	var toSummarize []ranked
	budget := KeepTokens
	for _, r := range items {
		if budget >= r.tokens {
			kept = append(kept, r)
			budget -= r.tokens
		} else {
			toSummarize = append(toSummarize, r)
		}
	}

	// 5. Summarize discarded messages
	summary := ""
	if len(toSummarize) > 0 {
		sumMsgs := make([]map[string]string, len(toSummarize))
		for i, r := range toSummarize {
			sumMsgs[i] = map[string]string{"role": r.msg.Role, "content": r.msg.Content}
		}
		var err error
		summary, err = o.embedder.Summarize(sumMsgs, geminiKey, SummaryTokens)
		if err != nil {
			fmt.Printf("[Compress] summarize error: %v\n", err)
			summary = fmt.Sprintf("[%d messages compressed — summarization unavailable]", len(toSummarize))
		}
	}

	// 6. Rebuild: summary first, then kept messages in original order
	// Sort kept by original index to preserve conversation flow
	for i := range kept {
		for j := i + 1; j < len(kept); j++ {
			if kept[j].idx < kept[i].idx {
				kept[i], kept[j] = kept[j], kept[i]
			}
		}
	}

	var parts []string
	if summary != "" {
		parts = append(parts, "--- Previous context (compressed) ---\n"+summary+"\n--- End compressed context ---")
	}
	for _, r := range kept {
		parts = append(parts, fmt.Sprintf("[%s] %s", r.msg.Role, r.msg.Content))
	}

	return strings.Join(parts, "\n\n"), nil
}

// BuildInjection creates the context to prepend to a user message.
// Includes top3 KB + top3 cross-agent messages.
func (o *Optimizer) BuildInjection(project, query, currentAgent string) string {
	if o.embedder == nil {
		return ""
	}

	var queryVec []float32
	queryVec, _ = o.embedder.Embed(query)

	var parts []string

	// Top 3 KB chunks
	if o.kbRepo != nil {
		chunks, _ := o.kbRepo.FindRelevant(project, query, queryVec, 3)
		for _, c := range chunks {
			name := c.SourceFile
			if idx := strings.LastIndex(name, "/"); idx >= 0 {
				name = name[idx+1:]
			}
			parts = append(parts, fmt.Sprintf("[KB:%s] %s", name, c.Content))
		}
	}

	// Top 3 messages from OTHER agents
	if o.msgRepo != nil {
		msgs, _ := o.msgRepo.FindRelevant(project, query, queryVec, 6)
		count := 0
		for _, m := range msgs {
			if m.Agent != currentAgent && count < 3 {
				parts = append(parts, fmt.Sprintf("[%s/%s] %s", m.Agent, m.Role, m.Content))
				count++
			}
		}
	}

	if len(parts) == 0 {
		return ""
	}
	return "--- Relevant context ---\n" + strings.Join(parts, "\n\n") + "\n--- End context ---\n\n"
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
	return dot / (na * nb) // simplified, no sqrt needed for ranking
}
