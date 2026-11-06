import { listSessions, requireActor } from '../../modules/auth'
export default defineEventHandler((event) => listSessions(requireActor(event)))
