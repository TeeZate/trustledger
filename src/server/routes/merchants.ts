import { FastifyInstance } from 'fastify'
import { db } from '../../db/index'
import { randomBytes } from 'crypto'

export const merchantRoutes = async (server: FastifyInstance) => {

  // Layer 3 — per merchant API key (1000 req/min)
  server.addHook('onRequest', async (request, reply) => {
    const apiKey = request.headers['x-api-key'] as string
    if (!apiKey) return

    const key = `merchant:${apiKey}`
    // Rate limit is handled by global limiter
    // This hook is for future per-key throttling
  })

  // Register a new merchant
  server.post('/merchants/register', async (request, reply) => {
    const { name } = request.body as { name: string }

    if (!name || name.trim().length < 2) {
      return reply.status(400).send({ 
        error: 'Merchant name is required' 
      })
    }

    // Generate a secure API key
    const api_key = `tl_${randomBytes(32).toString('hex')}`

    const [merchant] = await db('merchants')
      .insert({ 
        name:         name.trim(),
        api_key,
        balance:      0,
        total_earned: 0,
        active:       true
      })
      .returning(['id', 'name', 'api_key', 'created_at'])

    return reply.status(201).send({
      message:    'Merchant registered successfully',
      merchant_id: merchant.id,
      name:        merchant.name,
      api_key:     merchant.api_key,
      warning:     'Save your api_key — it will not be shown again'
    })
  })

  // Register a priced endpoint
  server.post('/merchants/endpoints', async (request, reply) => {
    const { api_key, path, price } = request.body as {
      api_key: string
      path:    string
      price:   number
    }

    // Verify merchant
    const merchant = await db('merchants')
      .where({ api_key, active: true })
      .first()

    if (!merchant) {
      return reply.status(401).send({ error: 'Invalid API key' })
    }

    if (!path || price <= 0) {
      return reply.status(400).send({ 
        error: 'Valid path and price required' 
      })
    }

    const [endpoint] = await db('endpoints')
      .insert({
        merchant_id: merchant.id,
        path:        path.trim(),
        price:       Number(price.toFixed(8)),
        active:      true
      })
      .returning(['id', 'path', 'price'])

    return reply.status(201).send({
      message:     'Endpoint registered',
      endpoint_id: endpoint.id,
      path:        endpoint.path,
      price:       endpoint.price
    })
  })

  // Get merchant dashboard data
  server.get('/merchants/dashboard', async (request, reply) => {
    const api_key = (request.headers['x-api-key'] as string)

    if (!api_key) {
      return reply.status(401).send({ error: 'API key required' })
    }

    const merchant = await db('merchants')
      .where({ api_key, active: true })
      .first()

    if (!merchant) {
      return reply.status(401).send({ error: 'Invalid API key' })
    }

    // Get recent transactions
    const transactions = await db('ledger')
      .where({ merchant_id: merchant.id })
      .orderBy('created_at', 'desc')
      .limit(50)

    // Get endpoint list
    const endpoints = await db('endpoints')
      .where({ merchant_id: merchant.id, active: true })
      .select('id', 'path', 'price')

    // Calculate today's earnings
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const todayEarnings = await db('ledger')
      .where({ merchant_id: merchant.id })
      .where('created_at', '>=', today)
      .sum('merchant_receives as total')
      .first()

    return reply.send({
      merchant: {
        id:            merchant.id,
        name:          merchant.name,
        balance:       Number(merchant.balance),
        total_earned:  Number(merchant.total_earned),
        today_earned:  Number(todayEarnings?.total || 0)
      },
      endpoints,
      recent_transactions: transactions
    })
  })

  // Get all endpoints for a merchant (used by middleware)
  server.get('/merchants/endpoints', async (request, reply) => {
    const api_key = (request.headers['x-api-key'] as string)

    const merchant = await db('merchants')
      .where({ api_key, active: true })
      .first()

    if (!merchant) {
      return reply.status(401).send({ error: 'Invalid API key' })
    }

    const endpoints = await db('endpoints')
      .where({ merchant_id: merchant.id, active: true })

    return reply.send({ endpoints })
  })
}