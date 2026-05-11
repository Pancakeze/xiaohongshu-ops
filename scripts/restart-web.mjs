#!/usr/bin/env node
/**
 * 结束占用 5173 的进程后启动前端热开发（Vite HMR）。
 * 用法：npm run dev:web:restart
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = 5173
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function killPort() {
  return new Promise((resolve) => {
    const p = spawn('lsof', ['-ti', `tcp:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout?.on('data', (d) => {
      out += d.toString()
    })
    p.on('close', () => {
      const pids = out
        .trim()
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean)
      if (pids.length === 0) {
        resolve(false)
        return
      }
      const k = spawn('kill', ['-9', ...pids], { stdio: 'inherit' })
      k.on('close', () => resolve(true))
    })
    p.on('error', () => resolve(false))
  })
}

const killed = await killPort()
if (killed) {
  console.log(`已释放端口 ${PORT}`)
  await delay(400)
} else {
  console.log(`端口 ${PORT} 无监听进程，直接启动`)
}

const child = spawn('npm', ['run', 'dev:hot', '--prefix', 'apps/web'], {
  stdio: 'inherit',
  cwd: root,
  shell: process.platform === 'win32',
})

child.on('exit', (code) => process.exit(code ?? 0))
