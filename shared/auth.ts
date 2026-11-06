export interface AuthActor {
  userId: string
  workspaceId: string
  sessionId: string
  role: 'owner' | 'editor' | 'viewer'
  username: string
}
export interface AuthStatus {
  enabled: boolean
  authenticated: boolean
  user: {
    id: string
    username: string
    role: 'owner' | 'editor' | 'viewer'
    workspaceId: string
  } | null
}
export interface DeviceSession {
  id: string
  deviceName: string
  createdAt: string
  expiresAt: string
  current: boolean
}
