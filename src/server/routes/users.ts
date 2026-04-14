import { FastifyInstance } from 'fastify'
import { db } from '../../db/index'
import { atomicDeduct, getBalance, getUserLedger } from '../ledger'
import { randomBytes } from 'crypto'

export const userRoutes = async (server: FastifyInstance) => {

  // Create a new user account
  server.post('/users/create', async (request, reply) => {
    const [user] = await db('users')
      .insert({
        display_name: null,
        balance:      0,
        reputation:   'new'
      })
      .returning(['id', 'balance', 'reputation', 'created_at'])

    return reply.status(201).send({
      message: 'Wallet created',
      user_id: user.id,
      balance: Number(user.balance)
    })
  })

  // Get user balance
  server.get('/users/:user_id/balance', async (request, reply) => {
    const { user_id } = request.params as { user_id: string }

    const user = await db('users')
      .where({ id: user_id })
      .select('id', 'balance', 'reputation')
      .first()

    if (!user) {
      return reply.status(404).send({ error: 'User not found' })
    }

    return reply.send({
      user_id:    user.id,
      balance:    Number(user.balance),
      reputation: user.reputation
    })
  })

  // Top up balance manually (test only — Stripe replaces this)
  server.post('/users/:user_id/topup', async (request, reply) => {
    const { user_id } = request.params as { user_id: string }
    const { amount }  = request.body as { amount: number }

    if (!amount || amount <= 0 || amount > 1000) {
      return reply.status(400).send({ 
        error: 'Amount must be between 0 and 1000' 
      })
    }

    const user = await db('users')
      .where({ id: user_id })
      .first()

    if (!user) {
      return reply.status(404).send({ error: 'User not found' })
    }

    // Add test topup record
    const stripe_payment_id = `test_${randomBytes(16).toString('hex')}`

    await db('topups').insert({
      user_id,
      amount,
      stripe_payment_id,
      status: 'completed'
    })

    // Credit the balance
    const [updated] = await db('users')
      .where({ id: user_id })
      .increment('balance', amount)
      .returning(['balance'])

    return reply.send({
      message:     'Balance topped up',
      user_id,
      amount_added: amount,
      new_balance:  Number(updated.balance)
    })
  })

  // Make a payment — the core action
  server.post('/users/pay', async (request, reply) => {
    const { user_id, merchant_id, endpoint_id, amount } = 
      request.body as {
        user_id:     string
        merchant_id: string
        endpoint_id: string
        amount:      number
      }

    if (!user_id || !merchant_id || !endpoint_id || !amount) {
      return reply.status(400).send({ 
        error: 'user_id, merchant_id, endpoint_id and amount required' 
      })
    }

    // Verify endpoint exists and price matches
    const endpoint = await db('endpoints')
      .where({ id: endpoint_id, merchant_id, active: true })
      .first()

    if (!endpoint) {
      return reply.status(404).send({ error: 'Endpoint not found' })
    }

    if (Number(endpoint.price) !== Number(amount)) {
      return reply.status(400).send({ 
        error: 'Amount does not match endpoint price' 
      })
    }

    // Run atomic deduction
    const result = await atomicDeduct({
      user_id,
      merchant_id,
      endpoint_id,
      amount: Number(amount)
    })

    if (!result.success) {
      return reply.status(402).send({ 
        error:       result.error,
        topup_url:  '/wallet/topup'
      })
    }

    return reply.send({
      success:      true,
      balance_after: result.balance_after
    })
  })

  // Get user transaction history
  server.get('/users/:user_id/history', async (request, reply) => {
    const { user_id } = request.params as { user_id: string }

    const user = await db('users')
      .where({ id: user_id })
      .first()

    if (!user) {
      return reply.status(404).send({ error: 'User not found' })
    }

    const history = await getUserLedger(user_id)

    return reply.send({
      user_id,
      balance: Number(user.balance),
      transactions: history
    })
  })
}