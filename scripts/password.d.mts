export function validPasswordHash(value: unknown): value is string
export function hashPassword(password: string): Promise<string>
export function verifyPassword(password: string, encoded: string): Promise<boolean>
