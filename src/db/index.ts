import knex from 'knex'
import dotenv from 'dotenv'
import { resolve } from 'path'

dotenv.config({ path: resolve(process.cwd(), '.env') })

export const db = knex({
  client: 'pg',
  connection: {
    host:     process.env.DB_HOST     || 'localhost',
    port:     Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME     || 'trustledger',
    user:     process.env.DB_USER     || 'postgres',
    password: String(process.env.DB_PASSWORD),
  },
  pool: { 
    min: 2, 
    max: 10,
    acquireTimeoutMillis: 30000,
  }
})

// Test connection
export const testConnection = async (): Promise<boolean> => {
  try {
    await db.raw('SELECT 1')
    return true
  } catch (err) {
    console.error('DB connection error:', err)
    return false
  }
}