package com.codexremote.console

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : ComponentActivity() {
    private val cryptoBox = CryptoBox()
    private lateinit var relay: RelayClient

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val androidId = getPreferences(MODE_PRIVATE).getString("androidId", null)
            ?: "android-${System.currentTimeMillis()}".also {
                getPreferences(MODE_PRIVATE).edit().putString("androidId", it).apply()
            }
        val androidName = android.os.Build.MODEL ?: "Android"
        cryptoBox.ensureKeyPair()

        setContent {
            val pairingText = remember { mutableStateOf("") }
            val status = remember { mutableStateOf("not connected") }
            val sessions = remember { mutableStateListOf<JSONObject>() }
            val messages = remember { mutableStateListOf<String>() }
            val selectedSessionId = remember { mutableStateOf<String?>(null) }
            val input = remember { mutableStateOf("") }

            fun handleResponse(body: JSONObject) {
                runOnUiThread {
                    if (!body.optBoolean("ok")) {
                        status.value = body.optString("error")
                        return@runOnUiThread
                    }
                    val result = body.opt("result")
                    when (result) {
                        is JSONArray -> {
                            sessions.clear()
                            for (i in 0 until result.length()) sessions.add(result.getJSONObject(i))
                        }
                        is JSONObject -> {
                            if (result.has("messages")) {
                                messages.clear()
                                val array = result.getJSONArray("messages")
                                for (i in 0 until array.length()) {
                                    val item = array.getJSONObject(i)
                                    messages.add("${item.optString("role")}: ${item.optString("text")}")
                                }
                            } else {
                                status.value = "sent"
                            }
                        }
                    }
                }
            }

            relay = RelayClient(
                cryptoBox = cryptoBox,
                androidId = androidId,
                androidName = androidName,
                onEvent = { runOnUiThread { status.value = it } },
                onRpcResponse = ::handleResponse
            )

            MaterialTheme {
                Surface(Modifier.fillMaxSize()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text("Codex Remote", style = MaterialTheme.typography.headlineSmall)
                        Text(status.value, style = MaterialTheme.typography.bodySmall)

                        OutlinedTextField(
                            value = pairingText.value,
                            onValueChange = { pairingText.value = it },
                            modifier = Modifier.fillMaxWidth(),
                            label = { Text("Pairing URI") }
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = {
                                val pairing = parsePairingUri(pairingText.value.trim())
                                relay.connect(pairing)
                            }) { Text("Connect") }
                            Button(onClick = { relay.rpc("sessions.list") }) { Text("Sessions") }
                        }

                        LazyColumn(Modifier.weight(1f)) {
                            items(sessions) { session ->
                                Card(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(vertical = 4.dp),
                                    onClick = {
                                        selectedSessionId.value = session.getString("id")
                                        relay.rpc("sessions.read", JSONObject().put("sessionId", selectedSessionId.value))
                                    }
                                ) {
                                    Column(Modifier.padding(12.dp)) {
                                        Text(session.optString("title"), style = MaterialTheme.typography.titleMedium)
                                        Text(session.optString("cwd"), style = MaterialTheme.typography.bodySmall)
                                    }
                                }
                            }
                            items(messages) { message ->
                                Text(message, modifier = Modifier.padding(vertical = 4.dp))
                            }
                        }

                        OutlinedTextField(
                            value = input.value,
                            onValueChange = { input.value = it },
                            modifier = Modifier.fillMaxWidth(),
                            label = { Text("Message") }
                        )
                        Button(
                            enabled = selectedSessionId.value != null && input.value.isNotBlank(),
                            onClick = {
                                relay.rpc(
                                    "sessions.send",
                                    JSONObject().put("sessionId", selectedSessionId.value).put("text", input.value)
                                )
                                input.value = ""
                            }
                        ) { Text("Send") }
                    }
                }
            }
        }
    }
}
