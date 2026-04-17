import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import dotenv from 'dotenv'
import { resolve } from 'path'
import { readFileSync } from 'fs'
import { testConnection } from '../db/index'
import { merchantRoutes } from './routes/merchants'
import { userRoutes } from './routes/users'
import { authRoutes } from './routes/auth'
import { walletRoutes } from './routes/wallet'
import { validateEnv } from './config'
import rawBody from 'fastify-raw-body'
import { payoutRoutes } from './routes/payouts'
import { runAudit } from './audit'
import { auditRoutes } from './routes/audit'

dotenv.config({ path: resolve(process.cwd(), '.env') })

validateEnv()

const server = Fastify({
  logger: true,
  bodyLimit: 1048576
})

const start = async () => {
  try {

    await server.register(helmet)

await server.register(cors, {
      origin: process.env.NODE_ENV === 'development'
        ? ['http://localhost:5173', 'http://localhost:5174','http://localhost:3000',
           'http://localhost:5175', 'http://localhost:5176']
        : false
    })
    await server.register(rateLimit, {
      global: true,
      max: 100,
      timeWindow: 60000,
      addHeaders: {
        'x-ratelimit-limit': true,
        'x-ratelimit-remaining': true,
        'x-ratelimit-reset': true,
        'retry-after': true
      },
      errorResponseBuilder: (_request, context) => ({
        statusCode: 429,
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Try again in ${context.after}.`,
        retryAfter: context.after
      })
    })

    await server.register(rawBody, {
      field: 'rawBody',
      global: false,
      encoding: 'utf8',
      runFirst: true
    })

    // Health check
    server.get('/health', async () => {
      const dbAlive = await testConnection()
      return {
        status:    'alive',
        service:   'SynthPay',
        database:  dbAlive ? 'connected' : 'disconnected',
        timestamp: new Date().toISOString()
      }
    })

    // Test page — development only
    if (process.env.NODE_ENV === 'development') {
      server.get('/test', async (request, reply) => {
        const html = readFileSync(
          resolve(process.cwd(), 'passkey-test.html'),
          'utf-8'
        )
        return reply.type('text/html').send(html)
      })
    }

    server.register(merchantRoutes)
    server.register(userRoutes)
    server.register(authRoutes)
    server.register(walletRoutes)
    server.register(payoutRoutes)
    server.register(auditRoutes)

    // Nightly audit — runs at midnight every day
    const scheduleNightlyAudit = () => {
      const now     = new Date()
      const midnight = new Date()
      midnight.setHours(24, 0, 0, 0)
      const msUntilMidnight = midnight.getTime() - now.getTime()

      setTimeout(async () => {
        console.log('🔍 Running nightly audit...')
        await runAudit()
        scheduleNightlyAudit()  // Schedule next night
      }, msUntilMidnight)

      console.log(`⏰ Next audit scheduled in ${Math.round(msUntilMidnight / 1000 / 60)} minutes`)
    }

    scheduleNightlyAudit()

    await server.listen({
      port: Number(process.env.PORT) || 3000,
      host: '0.0.0.0'
    })

    console.log('🚀 SynthPay server running on port 3000')

  } catch (err) {
    server.log.error(err)
    process.exit(1)
  }
}

start()