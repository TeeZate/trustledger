import { FastifyInstance } from 'fastify'
import { db } from '../../db/index'
import { runAudit } from '../audit'

export const auditRoutes = async (server: FastifyInstance) => {

  // ── 5.06 MANUAL AUDIT TRIGGER — internal only ────────────────
  server.post('/audit/run', async (request, reply) => {
    const { secret } = request.body as { secret: string }

    if (secret !== process.env.AUDIT_SECRET) {
      return reply.status(401).send({ error: 'Unauthorised' })
    }

    const result = await runAudit()

    return reply.send({
      message: `Audit ${result.status}`,
      result
    })
  })

  // ── 5.07 GET LATEST AUDIT REPORT ─────────────────────────────
  server.get('/audit/latest', async (request, reply) => {
    const latest = await db('audit_log')
      .orderBy('run_at', 'desc')
      .first()

    if (!latest) {
      return reply.send({
        message: 'No audit has been run yet',
        status:  'PENDING'
      })
    }

    return reply.send({
      status:        latest.status,
      run_at:        latest.run_at,
      total_entries: latest.total_entries,
      total_volume:  Number(latest.total_volume),
      total_fees:    Number(latest.total_fees),
      chain_hash:    latest.chain_hash,
      anomalies:     latest.anomalies
    })
  })

  // ── 5.08 GET AUDIT HISTORY ────────────────────────────────────
  server.get('/audit/history', async (request, reply) => {
    const history = await db('audit_log')
      .orderBy('run_at', 'desc')
      .limit(30)
      .select(
        'id',
        'run_at',
        'status',
        'total_entries',
        'total_volume',
        'total_fees',
        'chain_hash',
        'anomalies'
      )

    return reply.send({
      total_audits: history.length,
      audits:       history
    })
  })
}