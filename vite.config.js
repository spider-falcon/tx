// vite.config.js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/tx/', // Replace with your repo name
  plugins: [react()],
})
