package store

import "strings"

// ftsQuery converts a natural language query to FTS5 syntax.
// Filters stopwords and joins with OR.
func ftsQuery(q string) string {
	stop := map[string]bool{
		"a": true, "o": true, "e": true, "de": true, "do": true, "da": true,
		"em": true, "um": true, "uma": true, "os": true, "as": true, "no": true,
		"na": true, "que": true, "com": true, "para": true, "por": true,
		"the": true, "is": true, "of": true, "and": true, "in": true, "to": true,
		"it": true, "on": true, "at": true, "an": true, "or": true,
	}
	words := strings.Fields(q)
	var kept []string
	for _, w := range words {
		w = strings.ToLower(strings.Trim(w, ".,;:!?\"'()"))
		if len(w) >= 2 && !stop[w] {
			kept = append(kept, `"`+w+`"`)
		}
	}
	if len(kept) == 0 {
		return ""
	}
	return strings.Join(kept, " OR ")
}
