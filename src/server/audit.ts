import { db } from '../db/index'
import { createHash } from 'crypto'

interface AuditResult {
  status:          'PASSED' | 'FAILED'
  total_entries:   number
  total_volume:    number
  total_fees:      number
  chain_hash:      string
  anomalies:       number
  anomaly_details: any[]
  run_at:          Date
}

// ── Core audit function ───────────────────────────────────────
export const runAudit = async (): Promise<AuditResult> => {
  const run_at    = new Date()
  const anomalies: any[] = []

  // 1. Fetch all ledger entries in order
  const entries = await db('ledger')
    .orderBy('created_at', 'asc')
    .select('*')

  let total_volume   = 0
  let total_fees     = 0
  let runningHash    = ''
  let previousHash   = '0000000000000000'

  // 2. Build hash chain — each entry includes previous hash
  for (const entry of entries) {
    const amount           = Number(entry.amount)
    const fee              = Number(entry.platform_fee)
    const merchant_recv    = Number(entry.merchant_receives)
    const balance_after    = Number(entry.user_balance_after)

    // Verify arithmetic integrity
    const expectedMerchant = amount - fee
    if (Math.abs(expectedMerchant - merchant_recv) > 0.000001) {
      anomalies.push({
        entry_id: entry.id,
        issue:    'Fee arithmetic mismatch',
        amount,
        fee,
        merchant_receives: merchant_recv,
        expected_merchant: expectedMerchant
      })
    }

    // Verify balance never goes negative
    if (balance_after < 0) {
      anomalies.push({
        entry_id: entry.id,
        issue:    'Negative balance detected',
        balance_after
      })
    }

    total_volume += amount
    total_fees   += fee

    // Chain hash — links each entry to the previous
    const entryData = `${entry.id}|${entry.user_id}|${entry.merchant_id}|${amount}|${fee}|${entry.created_at}|${previousHash}`
    runningHash  = createHash('sha256').update(entryData).digest('hex')
    previousHash = runningHash
  }

  // 3. Verify user balances match ledger
  const users = await db('users').select('id', 'balance')

  for (const user of users) {
    const ledgerTotal = await db('ledger')
      .where({ user_id: user.id })
      .sum('amount as total')
      .first()

    const topupTotal = await db('topups')
      .where({ user_id: user.id, status: 'completed' })
      .sum('amount as total')
      .first()

    const totalSpent    = Number(ledgerTotal?.total  || 0)
    const totalDeposited = Number(topupTotal?.total  || 0)
    const expectedBalance = totalDeposited - totalSpent
    const actualBalance   = Number(user.balance)

    if (Math.abs(expectedBalance - actualBalance) > 0.000001) {
      anomalies.push({
        user_id:          user.id,
        issue:            'Balance mismatch',
        expected_balance: expectedBalance,
        actual_balance:   actualBalance,
        difference:       actualBalance - expectedBalance
      })
    }
  }

  const status     = anomalies.length === 0 ? 'PASSED' : 'FAILED'
  const chain_hash = runningHash || createHash('sha256')
    .update('empty_ledger')
    .digest('hex')

  // 4. Store audit result
  await db('audit_log').insert({
    run_at,
    status,
    total_entries:   entries.length,
    total_volume:    total_volume.toFixed(8),
    total_fees:      total_fees.toFixed(8),
    chain_hash,
    anomalies:       anomalies.length,
    anomaly_details: anomalies.length > 0
      ? JSON.stringify(anomalies)
      : null
  })

  if (anomalies.length > 0) {
    console.error(`❌ AUDIT FAILED — ${anomalies.length} anomalies detected`)
    anomalies.forEach(a => console.error('  →', a))
  } else {
    console.log(`✅ AUDIT PASSED — ${entries.length} entries verified`)
    console.log(`   Volume: $${total_volume.toFixed(8)}`)
    console.log(`   Fees:   $${total_fees.toFixed(8)}`)
    console.log(`   Hash:   ${chain_hash.slice(0, 16)}...`)
  }

  return {
    status,
    total_entries:   entries.length,
    total_volume,
    total_fees,
    chain_hash,
    anomalies:       anomalies.length,
    anomaly_details: anomalies,
    run_at
  }
}