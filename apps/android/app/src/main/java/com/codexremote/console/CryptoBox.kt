package com.codexremote.console

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlin.random.Random
import org.json.JSONObject

private const val CONTEXT = "codex-remote-console-v1"

class CryptoBox(private val alias: String = "codex_remote_console_device") {
    private val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    fun ensureKeyPair(): String {
        if (!keyStore.containsAlias(alias)) {
            val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
            val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_AGREE_KEY)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setUserAuthenticationRequired(false)
                .build()
            generator.initialize(spec)
            generator.generateKeyPair()
        }
        return publicKeyB64()
    }

    fun publicKeyB64(): String {
        val publicKey = keyStore.getCertificate(alias).publicKey.encoded
        return publicKey.b64()
    }

    fun encryptJson(from: String, to: String, seq: Long, peerPublicKeyB64: String, body: JSONObject): JSONObject {
        val salt = Random.Default.nextBytes(16)
        val nonce = Random.Default.nextBytes(12)
        val key = deriveKey(peerPublicKeyB64, salt, from, to, seq)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, nonce))
        cipher.updateAAD("$CONTEXT:$from:$to:$seq".toByteArray())
        val encrypted = cipher.doFinal(body.toString().toByteArray())
        return JSONObject()
            .put("kind", "encrypted")
            .put("version", 1)
            .put("from", from)
            .put("to", to)
            .put("seq", seq)
            .put("salt", salt.b64())
            .put("nonce", nonce.b64())
            .put("payload", encrypted.b64())
    }

    fun decryptJson(frame: JSONObject, peerPublicKeyB64: String): JSONObject {
        val from = frame.getString("from")
        val to = frame.getString("to")
        val seq = frame.getLong("seq")
        val salt = frame.getString("salt").unb64()
        val nonce = frame.getString("nonce").unb64()
        val payload = frame.getString("payload").unb64()
        val key = deriveKey(peerPublicKeyB64, salt, from, to, seq)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, nonce))
        cipher.updateAAD("$CONTEXT:$from:$to:$seq".toByteArray())
        return JSONObject(String(cipher.doFinal(payload)))
    }

    fun pairingRequest(
        androidId: String,
        agentId: String,
        seq: Long,
        agentPublicKeyB64: String,
        pairingSecret: String,
        androidName: String
    ): JSONObject {
        val encrypted = encryptJson(
            androidId,
            agentId,
            seq,
            agentPublicKeyB64,
            JSONObject()
                .put("type", "event")
                .put("topic", "pairing.request")
                .put("body", JSONObject().put("pairingSecret", pairingSecret).put("androidName", androidName))
        )
        return JSONObject()
            .put("kind", "pairing_request")
            .put("version", 1)
            .put("from", androidId)
            .put("to", agentId)
            .put("seq", seq)
            .put("androidPublicKeyB64", publicKeyB64())
            .put("salt", encrypted.getString("salt"))
            .put("nonce", encrypted.getString("nonce"))
            .put("payload", encrypted.getString("payload"))
    }

    private fun deriveKey(peerPublicKeyB64: String, salt: ByteArray, from: String, to: String, seq: Long): SecretKeySpec {
        val keyFactory = KeyFactory.getInstance("EC")
        val peerPublic = keyFactory.generatePublic(X509EncodedKeySpec(peerPublicKeyB64.unb64()))
        val agreement = KeyAgreement.getInstance("ECDH")
        agreement.init(privateKey())
        agreement.doPhase(peerPublic, true)
        val shared = agreement.generateSecret()
        val material = CONTEXT.toByteArray() + "$from:$to:$seq".toByteArray() + salt + shared
        val digest = MessageDigest.getInstance("SHA-256").digest(material)
        return SecretKeySpec(digest, "AES")
    }

    private fun privateKey(): PrivateKey {
        return keyStore.getKey(alias, null) as PrivateKey
    }
}

fun ByteArray.b64(): String {
    return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(this)
}

fun String.unb64(): ByteArray {
    return java.util.Base64.getUrlDecoder().decode(this)
}
