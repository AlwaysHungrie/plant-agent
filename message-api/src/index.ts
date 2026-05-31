import { Hono, type Context, type Next } from 'hono'
import { cors } from 'hono/cors'
import { verify } from 'hono/jwt'
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction } from '@solana/spl-token'
import bs58 from 'bs58'

type Bindings = {
  DB: D1Database
  IMAGES: R2Bucket
  GENESIS_WALLET: string
  GENESIS_PRIVATE_KEY: string
  PUMP_WALLET: string
  WATER_RATE_USD_PER_L: string
  PUMP_FLOW_RATE_ML_PER_SEC: string
  PUMP_CONTACT_NAME: string
  PUMP_CONTACT_ID: string
  HELIUS_RPC: string
  JWT_SECRET: string
}

async function requireJwt(c: Context<{ Bindings: Bindings }>, next: Next) {
  const header = c.req.header('Authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token) return c.json({ error: 'forbidden' }, 403)
  try {
    await verify(token, c.env.JWT_SECRET, 'HS256')
  } catch {
    return c.json({ error: 'forbidden' }, 403)
  }
  return next()
}

const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')

async function sendUsdcToContact(privateKeyBase58: string, toAddress: string, amount: number, rpcUrl: string): Promise<string> {
  const connection = new Connection(rpcUrl, 'confirmed')
  const fromWallet = Keypair.fromSecretKey(bs58.decode(privateKeyBase58))
  const toPublicKey = new PublicKey(toAddress)

  const fromAta = getAssociatedTokenAddressSync(USDC_MINT, fromWallet.publicKey)
  const toAta = getAssociatedTokenAddressSync(USDC_MINT, toPublicKey)

  const transaction = new Transaction()

  const recipientAccountInfo = await connection.getAccountInfo(toAta)
  if (recipientAccountInfo === null) {
    transaction.add(
      createAssociatedTokenAccountInstruction(fromWallet.publicKey, toAta, toPublicKey, USDC_MINT)
    )
  }

  const parsedAmount = Math.round(amount * 1_000_000)
  transaction.add(
    createTransferCheckedInstruction(fromAta, USDC_MINT, toAta, fromWallet.publicKey, parsedAmount, 6)
  )

  const { blockhash } = await connection.getLatestBlockhash()
  transaction.recentBlockhash = blockhash
  transaction.feePayer = fromWallet.publicKey
  transaction.sign(fromWallet)

  const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false })
  console.log(`Transaction sent: ${signature}`)
  return signature
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'] }))

app.get('/', (c) => {
  return c.text('Hello Hono!')
})

app.get('/read', async (c) => {
  await c.env.DB.prepare(
    'INSERT INTO read_receipts (created_at) VALUES (?)'
  )
    .bind(new Date().toISOString())
    .run()
  return c.json({})
})

app.get('/read-receipts', async (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10))
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') ?? '20', 10)))
  const offset = (page - 1) * limit

  const { results } = await c.env.DB.prepare(
    'SELECT id, created_at FROM read_receipts ORDER BY id DESC LIMIT ? OFFSET ?'
  )
    .bind(limit, offset)
    .all()

  const totalRow = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM read_receipts'
  ).first<{ count: number }>()

  return c.json({
    page,
    limit,
    total: totalRow?.count ?? 0,
    results,
  })
})

app.post('/upload', async (c) => {
  const contentType = c.req.header('content-type') ?? 'application/octet-stream'
  const body = await c.req.arrayBuffer()
  if (body.byteLength === 0) {
    return c.json({ error: 'empty body' }, 400)
  }

  const now = new Date()
  const key = `plant/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${now.getTime()}-${crypto.randomUUID()}`

  await c.env.IMAGES.put(key, body, {
    httpMetadata: { contentType },
  })

  const createdAt = now.toISOString()
  const { meta } = await c.env.DB.prepare(
    'INSERT INTO images (r2_key, content_type, size, created_at) VALUES (?, ?, ?, ?)'
  )
    .bind(key, contentType, body.byteLength, createdAt)
    .run()

  const id = meta.last_row_id
  const url = new URL(c.req.url)
  return c.json({
    id,
    key,
    size: body.byteLength,
    content_type: contentType,
    created_at: createdAt,
    url: `${url.origin}/image/${id}`,
  })
})

app.get('/image/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10)
  if (!Number.isFinite(id)) return c.json({ error: 'bad id' }, 400)

  const row = await c.env.DB.prepare(
    'SELECT r2_key, content_type FROM images WHERE id = ?'
  )
    .bind(id)
    .first<{ r2_key: string; content_type: string }>()

  if (!row) return c.json({ error: 'not found' }, 404)

  const obj = await c.env.IMAGES.get(row.r2_key)
  if (!obj) return c.json({ error: 'missing in r2' }, 404)

  return new Response(obj.body, {
    headers: {
      'content-type': row.content_type,
      'cache-control': 'public, max-age=31536000, immutable',
    },
  })
})

app.get('/images', async (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10))
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') ?? '20', 10)))
  const offset = (page - 1) * limit

  const { results } = await c.env.DB.prepare(
    'SELECT id, r2_key, content_type, size, created_at FROM images ORDER BY id DESC LIMIT ? OFFSET ?'
  )
    .bind(limit, offset)
    .all()

  const url = new URL(c.req.url)
  const enriched = (results as Array<{ id: number; r2_key: string; content_type: string; size: number; created_at: string }>)
    .map((r) => ({ ...r, url: `${url.origin}/image/${r.id}` }))

  return c.json({ page, limit, results: enriched })
})

app.get('/config', (c) => {
  const waterRate = Number(c.env.WATER_RATE_USD_PER_L)
  const flowRate = Number(c.env.PUMP_FLOW_RATE_ML_PER_SEC)
  const body = {
    genesis: {
      name: 'Genesis@Tumbuh',
      tagline: 'Autonomous Plant #00001',
      wallet: c.env.GENESIS_WALLET,
    },
    contacts: [
      {
        id: c.env.PUMP_CONTACT_ID,
        name: c.env.PUMP_CONTACT_NAME,
        wallet: c.env.PUMP_WALLET,
        water_rate_usd_per_l: waterRate,
        flow_rate_ml_per_sec: flowRate,
      },
    ],
  }
  return c.json(body, 200, {
    'cache-control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
  })
})

type MessageRow = {
  id: number
  contact_id: string
  volume_ml: number
  cost_usd: number
  duration_sec: number
  received: number
  txn: string
  created_at: string
}

const serializeMessage = (r: MessageRow) => ({
  id: r.id,
  contact_id: r.contact_id,
  volume_ml: r.volume_ml,
  cost_usd: r.cost_usd,
  duration_sec: r.duration_sec,
  received: r.received === 1,
  txn: r.txn ?? '',
  created_at: r.created_at,
})

app.get('/messages', async (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10))
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') ?? '20', 10)))
  const offset = (page - 1) * limit
  const contactId = c.req.query('contact_id')

  const where = contactId ? 'WHERE contact_id = ?' : ''
  const binds: unknown[] = contactId ? [contactId, limit, offset] : [limit, offset]

  const { results } = await c.env.DB.prepare(
    `SELECT id, contact_id, volume_ml, cost_usd, duration_sec, received, txn, created_at FROM messages ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
  )
    .bind(...binds)
    .all<MessageRow>()

  const totalRow = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM messages ${where}`
  )
    .bind(...(contactId ? [contactId] : []))
    .first<{ count: number }>()

  return c.json({
    page,
    limit,
    total: totalRow?.count ?? 0,
    results: (results ?? []).map(serializeMessage),
  })
})

app.get('/messages/pending', async (c) => {
  const contactId = c.req.query('contact_id')
  const where = contactId ? 'WHERE received = 0 AND contact_id = ?' : 'WHERE received = 0'
  const binds: unknown[] = contactId ? [contactId] : []

  const { results } = await c.env.DB.prepare(
    `SELECT id, contact_id, volume_ml, cost_usd, duration_sec, received, txn, created_at FROM messages ${where} ORDER BY id ASC LIMIT 10`
  )
    .bind(...binds)
    .all<MessageRow>()

  return c.json({
    results: (results ?? []).map(serializeMessage),
  })
})

app.post('/messages', requireJwt, async (c) => {
  const body = await c.req.json<{
    contact_id?: string
    volume_ml?: number
  }>().catch(() => null)
  if (!body) return c.json({ error: 'invalid json' }, 400)

  const contactId = body.contact_id ?? c.env.PUMP_CONTACT_ID
  const volume = Number(body.volume_ml)
  if (!Number.isFinite(volume) || volume <= 0) {
    return c.json({ error: 'volume_ml must be positive number' }, 400)
  }

  const waterRate = Number(c.env.WATER_RATE_USD_PER_L)
  const flowRate = Number(c.env.PUMP_FLOW_RATE_ML_PER_SEC)
  const costUsd = (volume / 1000) * waterRate
  const durationSec = volume / flowRate
  const createdAt = new Date().toISOString()

  const { meta } = await c.env.DB.prepare(
    `INSERT INTO messages (contact_id, volume_ml, cost_usd, duration_sec, received, txn, created_at)
     VALUES (?, ?, ?, ?, 0, '', ?)`
  )
    .bind(contactId, volume, costUsd, durationSec, createdAt)
    .run()

  const row = await c.env.DB.prepare(
    `SELECT id, contact_id, volume_ml, cost_usd, duration_sec, received, txn, created_at FROM messages WHERE id = ?`
  )
    .bind(meta.last_row_id)
    .first<MessageRow>()

  if (!row) return c.json({ error: 'insert failed' }, 500)
  return c.json(serializeMessage(row), 201)
})

app.patch('/messages/:id', requireJwt, async (c) => {
  const id = parseInt(c.req.param('id') ?? '', 10)
  if (!Number.isFinite(id)) return c.json({ error: 'bad id' }, 400)

  const body = await c.req.json<{ received?: boolean; txn?: string }>().catch(() => null)
  if (!body) return c.json({ error: 'invalid json' }, 400)

  const settingReceived = body.received === true

  // Fetch current row before update to check prior state
  const existing = await c.env.DB.prepare(
    `SELECT id, contact_id, volume_ml, cost_usd, duration_sec, received, txn, created_at FROM messages WHERE id = ?`
  )
    .bind(id)
    .first<MessageRow>()
  if (!existing) return c.json({ error: 'not found' }, 404)

  const sets: string[] = []
  const binds: unknown[] = []
  if (typeof body.received === 'boolean') {
    sets.push('received = ?')
    binds.push(body.received ? 1 : 0)
  }
  if (typeof body.txn === 'string') {
    sets.push('txn = ?')
    binds.push(body.txn)
  }

  // Auto-transfer USDC when marking received for first time
  if (settingReceived && existing.received === 0 && !body.txn) {
    try {
      const sig = await sendUsdcToContact(
        c.env.GENESIS_PRIVATE_KEY,
        c.env.PUMP_WALLET,
        existing.cost_usd,
        c.env.HELIUS_RPC,
      )
      sets.push('txn = ?')
      binds.push(sig)
    } catch (err) {
      console.error('USDC transfer failed:', err)
      return c.json({ error: 'usdc transfer failed' }, 502)
    }
  }

  if (sets.length === 0) return c.json({ error: 'nothing to update' }, 400)

  binds.push(id)
  const { meta } = await c.env.DB.prepare(
    `UPDATE messages SET ${sets.join(', ')} WHERE id = ?`
  )
    .bind(...binds)
    .run()

  if (meta.changes === 0) return c.json({ error: 'not found' }, 404)

  const row = await c.env.DB.prepare(
    `SELECT id, contact_id, volume_ml, cost_usd, duration_sec, received, txn, created_at FROM messages WHERE id = ?`
  )
    .bind(id)
    .first<MessageRow>()
  return c.json(serializeMessage(row!))
})

app.delete('/messages/:id', requireJwt, async (c) => {
  const id = parseInt(c.req.param('id') ?? '', 10)
  if (!Number.isFinite(id)) return c.json({ error: 'bad id' }, 400)

  const { meta } = await c.env.DB.prepare('DELETE FROM messages WHERE id = ?')
    .bind(id)
    .run()
  if (meta.changes === 0) return c.json({ error: 'not found' }, 404)
  return c.json({ ok: true })
})

export default app
