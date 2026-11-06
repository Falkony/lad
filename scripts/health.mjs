try {
  const port = process.env.NITRO_PORT || 3000,
    host =
      process.env.LAD_AUTH_ENABLED === '1'
        ? new URL(process.env.LAD_PUBLIC_ORIGIN).host
        : `127.0.0.1:${port}`
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/status`, {
    headers: { host },
    signal: AbortSignal.timeout(5000),
  })
  process.exitCode = response.ok ? 0 : 1
} catch {
  process.exitCode = 1
}
