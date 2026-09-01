# Add GET /users/:id/orders

## Context

Clients currently make two calls to render the account page: one for the user and
one for their orders. We want a single endpoint that returns both plus total spend.

## Approach

1. Add `src/handlers/getUserOrders.ts`.
2. For performance, issue a single SQL join across `users` and `orders` directly in
   the handler using `query()` from `src/db/pool`, rather than making two separate
   repository calls.
3. Aggregate `SUM(total_cents)` in the same query to get total spend.
4. Register the route.
