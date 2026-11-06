import { emitKeypressEvents } from 'node:readline'
import { hashPassword } from './password.mjs'
async function hiddenPassword() {
  process.stderr.write('Пароль (12–256 символов): ')
  emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  return new Promise((resolve, reject) => {
    let value = ''
    const finish = () => {
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdin.removeListener('keypress', key)
      process.stderr.write('\n')
    }
    const key = (text, pressed = {}) => {
      if (pressed.ctrl && pressed.name === 'c') {
        finish()
        reject(new Error('Отменено'))
      } else if (pressed.name === 'return') {
        finish()
        resolve(value)
      } else if (pressed.name === 'backspace') value = value.slice(0, -1)
      else if (text && !pressed.ctrl && value.length < 256) value += text
    }
    process.stdin.on('keypress', key)
  })
}
try {
  let password
  if (process.stdin.isTTY) password = await hiddenPassword()
  else {
    let value = ''
    for await (const chunk of process.stdin) {
      value += chunk.toString()
      if (Buffer.byteLength(value) > 2048) throw new Error('Слишком длинный пароль')
    }
    password = value.replace(/\r?\n$/, '')
  }
  process.stdout.write((await hashPassword(password)) + '\n')
} catch (error) {
  process.stderr.write(error.message + '\n')
  process.exitCode = 1
}
