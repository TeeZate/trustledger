import { FastifyInstance } from 'fastify'
import { db } from '../../db/index'
import Stripe from 'stripe'
import dotenv from 'dotenv'
import { resolve } from 'path'

dotenv.config({ path: resolve(process.cwd(), '.env') })

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-03-25.dahlia'
})

const MINIMUM_TOPUP = 20.00

export const walletRoutes = async (server: FastifyInstance) => {

  server.post('/wallet/topup/create', async (request, reply) => {
    const { user_id, amount } = request.body as {
      user_id: string
      amount:  number
    }

    if (!user_id || !amount) {
      return reply.status(400).send({ error: 'user_id and amount required' })
    }

    if (amount < MINIMUM_TOPUP) {
      return reply.status(400).send({
        error:   `Minimum top-up amount is $${MINIMUM_TOPUP}`,
        minimum: MINIMUM_TOPUP
      })
    }

    if (amount > 1000) {
      return reply.status(400).send({ error: 'Maximum top-up amount is $1,000' })
    }

    const user = await db('users').where({ id: user_id }).first()

    if (!user) {
      return reply.status(404).send({ error: 'User not found' })
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount:   Math.round(amount * 100),
      currency: 'usd',
      automatic_payment_methods: {
        enabled:         true,
        allow_redirects: 'never'
      },
      metadata: {
        user_id,
        type:     'wallet_topup',
        platform: 'synthpay'
      },
      description: `SynthPay wallet top-up for user ${user_id}`,
    })

    await db('topups').insert({
      user_id,
      amount,
      stripe_payment_id: paymentIntent.id,
      status: 'pending'
    })

    return reply.send({
      client_secret:     paymentIntent.client_secret,
      payment_intent_id: paymentIntent.id,
      amount,
      currency:          'usd'
    })
  })

  server.post('/wallet/topup/webhook', {
    config: { rawBody: true }
  }, async (request, reply) => {
    const sig = request.headers['stripe-signature'] as string

    if (!sig) {
      return reply.status(400).send({ error: 'Missing stripe-signature header' })
    }

    let event: any

    try {
      event = stripe.webhooks.constructEvent(
        (request as any).rawBody || JSON.stringify(request.body),
        sig,
        process.env.STRIPE_WEBHOOK_SECRET!
      )
    } catch (err: any) {
      console.error('Webhook signature verification failed:', err.message)
      return reply.status(400).send({ error: `Webhook error: ${err.message}` })
    }

    if (event.type === 'payment_intent.succeeded') {
      const paymentIntent = event.data.object as any
      const { user_id, type } = paymentIntent.metadata

      if (type !== 'wallet_topup' || !user_id) {
        return reply.send({ received: true })
      }

      const topup = await db('topups')
        .where({ stripe_payment_id: paymentIntent.id })
        .first()

      if (!topup) {
        console.error('Topup record not found for:', paymentIntent.id)
        return reply.send({ received: true })
      }

      if (topup.status === 'completed') {
        console.log('Duplicate webhook ignored:', paymentIntent.id)
        return reply.send({ received: true })
      }

      const amount = paymentIntent.amount / 100

      await db.transaction(async (trx) => {
        await trx('users')
          .where({ id: user_id })
          .increment('balance', amount)

        await trx('topups')
          .where({ stripe_payment_id: paymentIntent.id })
          .update({ status: 'completed' })
      })

      console.log(`✅ Wallet credited: user ${user_id} +$${amount}`)
    }

    if (event.type === 'payment_intent.payment_failed') {
      const paymentIntent = event.data.object as any

      await db('topups')
        .where({ stripe_payment_id: paymentIntent.id })
        .update({ status: 'failed' })

      console.log(`❌ Payment failed: ${paymentIntent.id}`)
    }

    return reply.send({ received: true })
  })

  server.get('/wallet/topups/:user_id', async (request, reply) => {
    const { user_id } = request.params as { user_id: string }

    const topups = await db('topups')
      .where({ user_id })
      .orderBy('created_at', 'desc')
      .limit(50)

    const total = topups
      .filter((t: any) => t.status === 'completed')
      .reduce((sum: number, t: any) => sum + Number(t.amount), 0)

    return reply.send({
      user_id,
      total_deposited: total,
      topups
    })
  })
}