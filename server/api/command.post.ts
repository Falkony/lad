import { commandSchema, executeCommand } from '../modules/workspace'
export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const parsed = commandSchema.safeParse(body)
  if (!parsed.success)
    throw createError({
      statusCode: 400,
      message: 'Проверьте заполненные поля',
      data: { issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) },
    })
  try {
    return await executeCommand(parsed.data)
  } catch (error: any) {
    if (error.statusCode) throw error
    const cause = error.cause || error
    const code = cause.code
    // postgres-js reports `constraint_name`, PGlite reports `constraint`.
    const constraint = String(cause.constraint_name || cause.constraint || '')
    if (code === '23505')
      throw createError({
        statusCode: 409,
        message: constraint.includes('import_key')
          ? 'Запись с таким банковским идентификатором уже существует.'
          : 'Такая запись уже существует. Обновите данные.',
      })
    if (code === '23503')
      throw createError({
        statusCode: 409,
        message: 'Связанная запись отсутствует или ещё используется. Обновите данные.',
      })
    console.error(`[lad] command ${parsed.data.op} failed`, error)
    throw createError({
      statusCode: 500,
      message: 'Не удалось завершить операцию. Обновите данные перед повтором.',
    })
  }
})
