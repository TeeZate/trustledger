import { FastifyInstance } from 'fastify'
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server'
import { db } from '../../db/index'
import jwt from 'jsonwebtoken'
import { randomBytes } from 'crypto'

const RP_NAME   = 'SynthPay'
const RP_ID     = process.env.WEBAUTHN_RPID     || 'localhost'
const ORIGIN    = process.env.WEBAUTHN_ORIGIN   || 'http://localhost:3000'
const JWT_SECRET = process.env.JWT_SECRET       || 'changeme'

// Helper — clean expired challenges
const cleanChallenges = async () => {
  await db('challenges').where('expires_at', '<', new Date()).delete()
}

export const authRoutes = async (server: FastifyInstance) => {

  // ── 2.02 REGISTRATION BEGIN ──────────────────────────────────
  server.post('/auth/register/begin', async (request, reply) => {
    await cleanChallenges()

    // Generate a new user ID for this registration
    const userId = randomBytes(16).toString('hex')

    const options = await generateRegistrationOptions({
      rpName:               RP_NAME,
      rpID:                 RP_ID,
      userID:               Buffer.from(userId),
      userName:             `user_${userId.slice(0, 8)}`,
      userDisplayName:      'SynthPay User',
      attestationType:      'none',
      authenticatorSelection: {
        authenticatorAttachment: 'platform',  // Face ID / fingerprint
        userVerification:        'required',
        residentKey:             'preferred',
      },
      supportedAlgorithmIDs: [-7, -257],
    })

    // Store challenge temporarily — expires in 5 minutes
    await db('challenges').insert({
      challenge:  options.challenge,
      type:       'registration',
      user_id:    null,
      expires_at: new Date(Date.now() + 5 * 60 * 1000),
    })

    return reply.send({
      options,
      temp_user_id: userId,
    })
  })

  // ── 2.03 REGISTRATION COMPLETE ───────────────────────────────
  server.post('/auth/register/complete', async (request, reply) => {
    const { credential, temp_user_id, display_name } = request.body as {
      credential:   any
      temp_user_id: string
      display_name?: string
    }

    if (!credential || !temp_user_id) {
      return reply.status(400).send({ error: 'credential and temp_user_id required' })
    }

    // Find the challenge
    const stored = await db('challenges')
      .where({ type: 'registration' })
      .where('expires_at', '>', new Date())
      .orderBy('created_at', 'desc')
      .first()

    if (!stored) {
      return reply.status(400).send({ error: 'Challenge expired or not found' })
    }

    // Verify the credential
    let verification: any
    try {
      verification = await verifyRegistrationResponse({
        response:             credential,
        expectedChallenge:    stored.challenge,
        expectedOrigin:       ORIGIN,
        expectedRPID:         RP_ID,
        requireUserVerification: true,
      })
    } catch (err: any) {
      return reply.status(400).send({ error: err.message })
    }

    if (!verification.verified || !verification.registrationInfo) {
      return reply.status(400).send({ error: 'Verification failed' })
    }

    const { credential: cred } = verification.registrationInfo

    // Create the user
    const [user] = await db('users')
      .insert({
        display_name: display_name || null,
        balance:      0,
        reputation:   'new',
      })
      .returning(['id', 'balance'])

    // Save the passkey
    await db('passkeys').insert({
      user_id:       user.id,
      credential_id: cred.id,
      public_key:    Buffer.from(cred.publicKey).toString('base64'),
      counter:       cred.counter,
      device_type:   verification.registrationInfo.credentialDeviceType || 'unknown',
    })

    // Clean up challenge
    await db('challenges').where({ challenge: stored.challenge }).delete()

    // Issue JWT
    const token = jwt.sign(
      { user_id: user.id },
      JWT_SECRET,
      { expiresIn: '24h' }
    )

    return reply.status(201).send({
      message:  'Wallet created successfully',
      user_id:  user.id,
      balance:  Number(user.balance),
      token,
    })
  })

  // ── 2.04 LOGIN BEGIN ─────────────────────────────────────────
  server.post('/auth/login/begin', async (request, reply) => {
    await cleanChallenges()

    const options = await generateAuthenticationOptions({
      rpID:             RP_ID,
      userVerification: 'required',
    })

    // Store challenge
    await db('challenges').insert({
      challenge:  options.challenge,
      type:       'authentication',
      user_id:    null,
      expires_at: new Date(Date.now() + 5 * 60 * 1000),
    })

    return reply.send({ options })
  })

  // ── 2.05 LOGIN COMPLETE ──────────────────────────────────────
  server.post('/auth/login/complete', async (request, reply) => {
    const { credential } = request.body as { credential: any }

    if (!credential) {
      return reply.status(400).send({ error: 'credential required' })
    }

    // Find challenge
    const stored = await db('challenges')
      .where({ type: 'authentication' })
      .where('expires_at', '>', new Date())
      .orderBy('created_at', 'desc')
      .first()

    if (!stored) {
      return reply.status(400).send({ error: 'Challenge expired or not found' })
    }

  
    // Find the passkey — try multiple ID formats
        const credentialId = credential.id
        let passkey = await db('passkeys')
        .where({ credential_id: credentialId })
        .first()

        // Try base64url decoded version if not found
        if (!passkey) {
        const altId = Buffer.from(credentialId, 'base64url').toString('base64url')
        passkey = await db('passkeys')
            .where({ credential_id: altId })
            .first()
        }

        // Log what we have for debugging
        // console.log('Looking for credential:', credentialId)
        // const allPasskeys = await db('passkeys').select('credential_id')
        // console.log('Stored passkeys:', allPasskeys.map((p: any) => p.credential_id))

    if (!passkey) {
      return reply.status(404).send({ error: 'Passkey not found' })
    }

    // Verify
    let verification: any
    try {
      verification = await verifyAuthenticationResponse({
        response:          credential,
        expectedChallenge: stored.challenge,
        expectedOrigin:    ORIGIN,
        expectedRPID:      RP_ID,
        credential: {
            id:        passkey.credential_id,
            publicKey: new Uint8Array(Buffer.from(passkey.public_key, 'base64')),
            counter:   passkey.counter,
            },
        requireUserVerification: true,
      })
    } catch (err: any) {
      return reply.status(400).send({ error: err.message })
    }

    if (!verification.verified) {
      return reply.status(401).send({ error: 'Authentication failed' })
    }

    // Update counter — prevents replay attacks
    await db('passkeys')
      .where({ id: passkey.id })
      .update({ counter: verification.authenticationInfo.newCounter })

    // Get user
    const user = await db('users')
      .where({ id: passkey.user_id })
      .first()

    // Clean up challenge
    await db('challenges').where({ challenge: stored.challenge }).delete()

    // Issue JWT
    const token = jwt.sign(
      { user_id: user.id },
      JWT_SECRET,
      { expiresIn: '24h' }
    )

    return reply.send({
      message:  'Login successful',
      user_id:  user.id,
      balance:  Number(user.balance),
      token,
    })
  })
}