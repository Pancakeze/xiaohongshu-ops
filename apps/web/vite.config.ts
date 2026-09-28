import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/** Docker 内 Vite 代理到 compose 服务 api；本机开发默认 127.0.0.1:8000 */
const apiProxyTarget = process.env.VITE_PROXY_API ?? 'http://127.0.0.1:8000'
const devHost = process.env.VITE_DEV_HOST ?? '127.0.0.1'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  /** 本地热开发：默认开启 HMR（@vitejs/plugin-react 的 Fast Refresh） */
  server: {
    host: devHost,
    port: 5173,
    strictPort: true,
    hmr: {
      host: devHost === '0.0.0.0' ? '127.0.0.1' : devHost,
      port: 5173,
      overlay: true,
    },
    // macOS / 部分文件系统下，原生 fs events 偶发丢事件；开启 polling 兜底确保修改必触发 HMR。
    watch: {
      usePolling: true,
      interval: 120,
      ignored: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
    },
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
      },
      '/health': {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
})
