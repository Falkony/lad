import { z } from 'zod'

export const commandHistoryEntrySchema = z.object({
  id: z.uuid(),
  revision: z.string().regex(/^[1-9]\d{0,19}$/),
  createdAt: z
    .string()
    .max(40)
    .regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/)
    .refine((value) => Number.isFinite(Date.parse(value))),
  operation: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z][a-zA-Z.]*$/),
  payload: z.record(z.string(), z.json()),
  result: z.record(z.string(), z.json()),
})

export type CommandHistoryEntry = z.infer<typeof commandHistoryEntrySchema>
export interface CommandHistoryPage {
  entries: CommandHistoryEntry[]
  nextBefore: string | null
}

export const commandLabels: Record<string, string> = {
  'category.create': 'Создание категории',
  'category.rename': 'Переименование категории',
  'category.archive': 'Архивация категории',
  'category.merge': 'Объединение категорий',
  'settings.update': 'Настройка часового пояса',
  'account.create': 'Создание счёта',
  'account.update': 'Изменение счёта',
  'account.archive': 'Архивация или возврат счёта',
  'account.delete': 'Удаление счёта',
  'account.reconcile': 'Сверка остатка',
  'transaction.create': 'Запись операции',
  'transaction.update': 'Изменение операции',
  'transaction.delete': 'Удаление операции',
  'transaction.restore': 'Восстановление операции',
  'transactions.categorize': 'Смена категории операций',
  'goal.create': 'Создание цели',
  'goal.update': 'Изменение цели',
  'goal.delete': 'Удаление цели',
  'event.create': 'Создание события',
  'event.toggle': 'Отметка события',
  'event.delete': 'Удаление события',
  'shopping.create': 'Добавление покупки',
  'shopping.toggle': 'Отметка покупки',
  'shopping.delete': 'Удаление покупки',
  'shopping.checkout': 'Запись чека',
  'budget.set': 'Изменение бюджета',
  'budget.delete': 'Удаление лимита',
  'budget.copy': 'Копирование лимитов',
  'plan.save': 'Сохранение плана',
  'plan.toggle': 'Пауза или возобновление плана',
  'plan.delete': 'Удаление плана',
  'occurrence.confirm': 'Подтверждение даты плана',
  'occurrence.skip': 'Отмена даты плана',
  'occurrence.unskip': 'Возврат даты в план',
  'occurrence.adjust': 'Изменение даты плана',
  'obligation.create': 'Создание обязательства',
  'obligation.update': 'Изменение обязательства',
  'obligation.delete': 'Удаление обязательства',
  'obligation.pay': 'Погашение обязательства',
  'obligation.payment.update': 'Изменение погашения',
  'obligation.payment.cancel': 'Отмена погашения',
  'obligation.reconcile': 'Сверка долга',
  import: 'Импорт выписки',
  'demo.load': 'Загрузка демо',
  'workspace.reset': 'Очистка пространства',
  'workspace.restore': 'Восстановление пространства',
}
