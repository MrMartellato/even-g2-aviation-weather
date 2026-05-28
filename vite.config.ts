import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  server: {
    proxy: {
      '/api/metar': {
        target: 'https://aviationweather.gov',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/metar/, '/api/data/metar'),
      },
      '/api/taf': {
        target: 'https://aviationweather.gov',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/taf/, '/api/data/taf'),
      },
      '/api/stations': {
        target: 'https://aviationweather.gov',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/stations/, '/api/data/stationInfo'),
      },
      '/api/ip': {
        target: 'http://ip-api.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/ip/, '/json'),
      },
      '/api/atis': {
        target: 'https://datis.clowd.io',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/atis/, '/api'),
      },
    },
  },
});

