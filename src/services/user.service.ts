import { userRepository } from '../repositories/user.repository.ts';
import { NotFoundError } from '../errors/app-error.ts';

export class UserService {
  async getAllUsers() {
    return await userRepository.findAll();
  }

  async getUserById(id: bigint) {
    const user = await userRepository.findById(id);
    if (!user) {
      throw new NotFoundError(`Usuario con ID ${id} no encontrado`);
    }
    return user;
  }
}

export const userService = new UserService();
