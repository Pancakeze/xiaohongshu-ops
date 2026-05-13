import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  /** 本地热开发：默认开启 HMR（@vitejs/plugin-react 的 Fast Refresh） */
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    hmr: {
      host: '127.0.0.1',
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
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
})
