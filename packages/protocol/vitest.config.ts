import { defineConfig } from 'vitest/config'

// Yerel config sart: vitest config bulamazsa dizin agacini yukari tarar ve
// ev dizinindeki alakasiz bir vite.config.js'i yakalayabiliyor.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
