import { query } from "../db/pool";

export interface Order {
  id: string;
  userId: string;
  totalCents: number;
  placedAt: string;
}

export async function findOrdersByUserId(userId: string): Promise<Order[]> {
  return query<Order>(
    "SELECT id, user_id AS \"userId\", total_cents AS \"totalCents\", placed_at AS \"placedAt\" FROM orders WHERE user_id = $1 ORDER BY placed_at DESC",
    [userId],
  );
}
