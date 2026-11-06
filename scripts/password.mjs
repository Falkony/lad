import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
export const validPasswordHash = (value) =>
  typeof value === 'string' && /^scrypt\$32768\$8\$3\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(value)
const derive = (password, salt) =>
  new Promise((resolve, reject) =>
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 128 * 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  )
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256)
    throw new Error('Пароль должен содержать от 12 до 256 символов')
  const salt = randomBytes(16)
  return `scrypt$32768$8$3$${salt.toString('hex')}$${(await derive(password, salt)).toString('hex')}`
}
export async function verifyPassword(password, encoded) {
  if (!validPasswordHash(encoded) || typeof password !== 'string' || password.length > 256)
    return false
  const parts = encoded.split('$'),
    key = await derive(password, Buffer.from(parts[4], 'hex'))
  return timingSafeEqual(key, Buffer.from(parts[5], 'hex'))
}
