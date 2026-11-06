import { createError, getHeader, readRawBody, type H3Event } from 'h3'
import type { z } from 'zod'
export async function readJSON(event: H3Event, maxBytes = 25 * 1024 * 1024) {
  const declared = Number(getHeader(event, 'content-length'))
  if (declared > maxBytes) throw createError({ statusCode: 413, message: 'Запрос слишком большой' })
  const raw = (await readRawBody(event)) || ''
  if (Buffer.byteLength(raw) > maxBytes)
    throw createError({ statusCode: 413, message: 'Запрос слишком большой' })
  try {
    return JSON.parse(raw)
  } catch {
    throw createError({ statusCode: 400, message: 'Некорректный JSON' })
  }
}
export async function readValidatedJSON<T>(
  event: H3Event,
  schema: z.ZodType<T>,
  maxBytes = 25 * 1024 * 1024,
): Promise<T> {
  const result = schema.safeParse(await readJSON(event, maxBytes))
  if (!result.success)
    throw createError({
      statusCode: 400,
      message: 'Проверьте заполненные поля',
      data: { issues: result.error.issues.map(({ path, message }) => ({ path, message })) },
    })
  return result.data
}
