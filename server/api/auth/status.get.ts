import { authStatus } from '../../modules/auth'
export default defineEventHandler((event) => authStatus(event))
