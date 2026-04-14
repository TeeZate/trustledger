import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import dotenv from 'dotenv'
import { resolve } from 'path'
import { testConnection } from '../db/index'
import { merchantRoutes } from './routes/merchants'
import { userRoutes } from './routes/users'

dotenv.config({ path: resolve(process.cwd(), '.env') })

const server = Fastify({ logger: true })

server.register(cors, {
  origin: process.env.NODE_ENV === 'development' ? '*' : false
})

server.register(helmet)

server.get('/health', async () => {
  const dbAlive = await testConnection()
  return { 
    status:    'alive',
    service:   'TrustLedger',
    database:  dbAlive ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString()
  }
})

server.register(merchantRoutes)
server.register(userRoutes)

const start = async () => {
  try {
    await server.listen({ 
      port: Number(process.env.PORT) || 3000,
      host: '0.0.0.0'
    })
    console.log('🚀 TrustLedger server running on port 3000')
  } catch (err) {
    server.log.error(err)
    process.exit(1)
  }
}

start()