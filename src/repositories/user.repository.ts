import { eq } from 'drizzle-orm';
import { db } from '../config/database.ts';
import { users } from '../database/schema/index.ts';

export class UserRepository {
  async findAll() {
    return await db
      .select({
        UniqueID: users.UniqueID,
        email: users.email,
        role_id: users.role_id,
        state: users.state,
      })
      .from(users);
  }

  async findById(id: bigint) {
    const results = await db
      .select({
        UniqueID: users.UniqueID,
        email: users.email,
        role_id: users.role_id,
        state: users.state,
      })
      .from(users)
      .where(eq(users.UniqueID, id))
      .limit(1);

    return results[0] ?? null;
  }

  async findByEmail(email: string) {
    const results = await db
      .select({
        UniqueID: users.UniqueID,
        email: users.email,
        role_id: users.role_id,
        state: users.state,
      })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    return results[0] ?? null;
  }
}

export const userRepository = new UserRepository();
