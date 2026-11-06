/** Database ownership belongs to the receiving server; financial records stay portable. */
export function withoutWorkspaceId<T extends object>(row: T): Omit<T, 'workspaceId'> {
  const { workspaceId: _scope, ...data } = row as T & { workspaceId?: unknown }
  return data
}
export function portableRows<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).map(([key, data]) => [
      key,
      Array.isArray(data)
        ? data.map((row) =>
            row && typeof row === 'object' && !Array.isArray(row) ? withoutWorkspaceId(row) : row,
          )
        : data,
    ]),
  ) as T
}
