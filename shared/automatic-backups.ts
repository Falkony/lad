export interface AutomaticBackupFile {
  name: string
  createdAt: string
}

export interface AutomaticBackupStatus {
  directory: string
  every: number
  keep: number
  files: AutomaticBackupFile[]
  error: string | null
}
