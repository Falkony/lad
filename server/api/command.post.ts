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
    const code = error.cause?.code || error.code
    throw createError({
      statusCode: code === '23505' ? 409 : 500,
      message:
        code === '23505'
          ? 'Запись с таким банковским идентификатором уже существует.'
          : 'Не удалось завершить операцию. Обновите данные перед повтором.',
    })
  }
})
