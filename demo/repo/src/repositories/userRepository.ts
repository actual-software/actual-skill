// The only place in the codebase that is allowed to write SQL.
import { query } from "../db/pool";

export interface User {
  id: string;
  email: string;
  displayName: string;
}

export async function findUserById(id: string): Promise<User | null> {
  const rows = await query<User>(
    "SELECT id, email, display_name AS \"displayName\" FROM users WHERE id = $1",
    [id],
  );
  return rows[0] ?? null;
}
