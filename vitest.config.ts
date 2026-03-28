import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { join } from 'path'

export default defineConfig({
    plugins: [react()],
    test: {
        environment: 'node', // Les services Electron tournent principalement dans Node
        globals: true,
    },
    resolve: {
        alias: {
            '@': join(__dirname, './src'),
        },
    },
})
