import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import path from 'path'
import fs   from 'fs'
import { WebSocketServer } from 'ws'

export default defineConfig({
  base: '/Spatiality/',

  plugins: [
    // Self-signed HTTPS certificate — browsers accept it after one click-through
    basicSsl(),

    // ── Kiosk WebSocket relay ──────────────────────────────────────────────
    // Forwards every message from kiosk.html to AR (and vice-versa) so the
    // two pages can run on different physical devices on the same network.
    {
      name: 'kiosk-ws-relay',
      configureServer(server) {
        const wss = new WebSocketServer({ noServer: true })

        server.httpServer.on('upgrade', (req, socket, head) => {
          if (req.url === '/kiosk-ws') {
            wss.handleUpgrade(req, socket, head, ws => {
              wss.emit('connection', ws, req)
            })
          }
        })

        wss.on('connection', ws => {
          ws.on('message', data => {
            // Relay raw message to every other connected client
            wss.clients.forEach(client => {
              if (client !== ws && client.readyState === 1) {
                client.send(data.toString())
              }
            })
          })
        })

        console.log('\n  🎨  Kiosk WS relay ready at  wss://<host>/kiosk-ws\n')
      },
    },

    // ── Artwork snapshot save endpoint ────────────────────────────────────────
    // POST /api/save-artwork  { imageData: 'data:image/png;base64,…', artistName }
    // Saves PNG + JSON metadata to public/artworks/ and returns { id, url }
    {
      name: 'artwork-save',
      configureServer(server) {
        server.middlewares.use('/api/save-artwork', (req, res) => {
          if (req.method !== 'POST') {
            res.statusCode = 405; res.end(); return
          }
          let body = ''
          req.on('data', chunk => { body += chunk.toString() })
          req.on('end', () => {
            try {
              const { imageData, artistName = '' } = JSON.parse(body)
              // Unique ID: timestamp + random suffix
              const id  = Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
              const dir = path.resolve(__dirname, 'public/artworks')
              fs.mkdirSync(dir, { recursive: true })

              // Save PNG
              const buf = Buffer.from(
                imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64'
              )
              fs.writeFileSync(path.join(dir, `${id}.png`), buf)

              // Save metadata (artist name + timestamp)
              fs.writeFileSync(
                path.join(dir, `${id}.json`),
                JSON.stringify({ id, artistName, createdAt: Date.now() })
              )

              res.setHeader('Content-Type', 'application/json')
              res.setHeader('Access-Control-Allow-Origin', '*')
              res.end(JSON.stringify({ id, url: `/Spatiality/artworks/${id}.png` }))
              console.log(`  🖼️  Artwork saved: ${id}  (${(buf.length/1024).toFixed(0)} KB)`)
            } catch (e) {
              console.error('[artwork-save]', e.message)
              res.statusCode = 500
              res.end(JSON.stringify({ error: e.message }))
            }
          })
        })
      },
    },
  ],

  server: {
    host: true,    // listen on all interfaces so every device on the network can connect
    https: true,   // HTTPS via basicSsl() — required for getUserMedia on non-localhost
    port: 5173,
  },

  build: {
    rollupOptions: {
      input: {
        main:    path.resolve(__dirname, 'index.html'),
        kiosk:   path.resolve(__dirname, 'kiosk.html'),
        artwork: path.resolve(__dirname, 'artwork.html'),
      },
    },
  },
})
