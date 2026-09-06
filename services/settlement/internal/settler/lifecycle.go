package settler

import (
	"context"
	"time"

	"github.com/oddzilla/settlement/internal/store"
)

// ReconcileMatchLifecycle closes every match whose whole book is terminal
// but whose row never left not_started / live / suspended, and voices the
// transition on the odds channel so the storefront drops its pill. See
// store.CloseMatchesWithTerminalBooks for why the per-message close is not
// enough. Returns how many matches were flipped.
func (s *Settler) ReconcileMatchLifecycle(ctx context.Context) (int, error) {
	ids, err := store.CloseMatchesWithTerminalBooks(ctx, s.store.Pool())
	if err != nil {
		return 0, err
	}
	now := time.Now().UnixMilli()
	for _, id := range ids {
		s.publishMatchStatus(ctx, id, "closed", now)
	}
	return len(ids), nil
}
