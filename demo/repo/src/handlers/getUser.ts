// Reference handler. Note: no SQL, no pool import -- it calls the repository.
import type { Request, Response } from "express";
import { findUserById } from "../repositories/userRepository";

export async function getUser(req: Request, res: Response): Promise<void> {
  const user = await findUserById(req.params.id);
  if (!user) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(user);
}
