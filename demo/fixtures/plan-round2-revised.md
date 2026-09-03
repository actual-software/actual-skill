# Add GET /users/:id/orders

## Context

Clients currently make two calls to render the account page: one for the user and
one for their orders. We want a single endpoint that returns both plus total spend.

## Approach

1. Add `findOrdersWithTotalByUserId()` to `src/repositories/orderRepository.ts`,
   encapsulating the aggregate so it is named, testable, and reusable.
2. Add `src/handlers/getUserOrders.ts`, which calls `findUserById()` and the new
   repository function and formats the response. No SQL in the handler.
3. Register the route.
