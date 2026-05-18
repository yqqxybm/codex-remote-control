package com.codexremote.console

import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

class RelayClient(
    private val cryptoBox: CryptoBox,
    private val androidId: String,
    private val androidName: String,
    private val onEvent: (String) -> Unit,
    private val onConnected: (Pairing) -> Unit,
    private val onRpcResponse: (JSONObject) -> Unit
) {
    private val http = OkHttpClient()
    private val handler = Handler(Looper.getMainLooper())
    private var socket: WebSocket? = null
    private var seq = 1L
    private var pairing: Pairing? = null
    private var generation = 0

    fun connect(pairing: Pairing) {
        this.pairing = pairing
        generation += 1
        socket?.cancel()
        open(pairing, generation)
    }

    private fun open(pairing: Pairing, generation: Int) {
        val request = Request.Builder().url(pairing.relayUrl).build()
        socket = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                val hello = JSONObject()
                    .put("kind", "hello")
                    .put("deviceId", androidId)
                    .put("deviceName", androidName)
                    .put("role", "android")
                pairing.relayAccessToken?.let { hello.put("accessToken", it) }
                webSocket.send(hello.toString())
                webSocket.send(
                    cryptoBox.pairingRequest(
                        androidId,
                        pairing.agentId,
                        seq++,
                        pairing.agentPublicKeyB64,
                        pairing.pairingSecret,
                        androidName
                    ).toString()
                )
                onEvent("connected to ${pairing.agentName}")
                onConnected(pairing)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val frame = JSONObject(text)
                when (frame.optString("kind")) {
                    "encrypted" -> {
                        val body = cryptoBox.decryptJson(frame, pairing.agentPublicKeyB64)
                        if (body.optString("type") == "rpc_response") {
                            onRpcResponse(body)
                        }
                    }
                    "delivery_error" -> onEvent(frame.optString("message"))
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                scheduleReconnect("relay error: ${t.message ?: "connection failed"}", generation)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                scheduleReconnect("relay closed", generation)
            }
        })
    }

    fun rpc(method: String, params: JSONObject = JSONObject()) {
        val target = pairing ?: run {
            onEvent("not paired")
            return
        }
        val requestId = "android-${System.currentTimeMillis()}-${seq}"
        val body = JSONObject()
            .put("type", "rpc_request")
            .put("requestId", requestId)
            .put("method", method)
            .put("params", params)
        val envelope = cryptoBox.encryptJson(androidId, target.agentId, seq++, target.agentPublicKeyB64, body)
        socket?.send(envelope.toString())
    }

    private fun scheduleReconnect(message: String, generation: Int) {
        val target = pairing ?: return
        if (generation != this.generation) return
        onEvent("$message; reconnecting")
        handler.postDelayed({
            if (generation == this.generation) open(target, generation)
        }, 3000)
    }
}
