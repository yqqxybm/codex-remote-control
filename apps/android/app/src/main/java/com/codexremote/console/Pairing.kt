package com.codexremote.console

import org.json.JSONObject

data class Pairing(
    val relayUrl: String,
    val relayAccessToken: String?,
    val agentId: String,
    val agentName: String,
    val agentPublicKeyB64: String,
    val pairingSecret: String
)

fun parsePairingUri(uri: String): Pairing {
    val prefix = "codexrc://pair/"
    require(uri.startsWith(prefix)) { "Invalid pairing URI" }
    val raw = String(uri.removePrefix(prefix).unb64())
    val json = JSONObject(raw)
    return Pairing(
        relayUrl = json.getString("relayUrl"),
        relayAccessToken = json.optString("relayAccessToken").ifBlank { null },
        agentId = json.getString("agentId"),
        agentName = json.getString("agentName"),
        agentPublicKeyB64 = json.getString("agentPublicKeyB64"),
        pairingSecret = json.getString("pairingSecret")
    )
}
