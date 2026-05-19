package com.codexremote.console

import android.content.SharedPreferences
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

private const val PREF_PAIRING_URIS = "pairingUris"
private const val PREF_LEGACY_PAIRING_URI = "pairingUri"
private const val PREF_SELECTED_AGENT_ID = "selectedAgentId"
private const val REQUEST_TIMEOUT_MS = 30_000L

class MainActivity : ComponentActivity() {
    private val cryptoBox = CryptoBox()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val preferences = getPreferences(MODE_PRIVATE)
        val androidId = preferences.getString("androidId", null)
            ?: "android-${System.currentTimeMillis()}".also {
                preferences.edit().putString("androidId", it).apply()
            }
        val androidName = android.os.Build.MODEL ?: "Android"
        val mainHandler = Handler(Looper.getMainLooper())
        cryptoBox.ensureKeyPair()

        setContent {
            ConsoleTheme {
                val initialAgents = remember { loadPairingRecords(preferences) }
                val agents = remember {
                    mutableStateListOf<PairingRecord>().apply {
                        addAll(initialAgents)
                    }
                }
                var selectedAgentId by remember {
                    mutableStateOf(
                        preferences.getString(PREF_SELECTED_AGENT_ID, null)
                            ?.takeIf { savedId -> initialAgents.any { it.pairing.agentId == savedId } }
                            ?: initialAgents.firstOrNull()?.pairing?.agentId
                    )
                }
                var status by remember { mutableStateOf("Offline") }
                var pairingText by remember { mutableStateOf("") }
                var showPairingEditor by remember { mutableStateOf(agents.isEmpty()) }
                var selectedSessionId by remember { mutableStateOf<String?>(null) }
                var activeTurnId by remember { mutableStateOf<String?>(null) }
                var input by remember { mutableStateOf("") }
                val sessions = remember { mutableStateListOf<SessionRow>() }
                val messages = remember { mutableStateListOf<ChatMessage>() }
                val pendingRequests = remember { mutableMapOf<String, RpcContext>() }
                val latestRequests = remember { mutableMapOf<String, String>() }

                lateinit var relay: RelayClient

                fun selectedAgent(): PairingRecord? = agents.firstOrNull { it.pairing.agentId == selectedAgentId }

                fun saveAgents() {
                    savePairingRecords(preferences, agents, selectedAgentId)
                }

                fun resetThreadView() {
                    sessions.clear()
                    messages.clear()
                    selectedSessionId = null
                    activeTurnId = null
                    input = ""
                    pendingRequests.clear()
                    latestRequests.clear()
                }

                fun connect(record: PairingRecord) {
                    selectedAgentId = record.pairing.agentId
                    status = "Connecting ${record.pairing.agentName}"
                    resetThreadView()
                    saveAgents()
                    relay.connect(record.pairing)
                }

                fun markMessage(messageId: String, deliveryState: DeliveryState) {
                    val index = messages.indexOfFirst { it.id == messageId }
                    if (index >= 0) {
                        messages[index] = messages[index].copy(deliveryState = deliveryState)
                    }
                }

                fun sendRpc(
                    method: String,
                    params: JSONObject = JSONObject(),
                    sessionId: String? = null,
                    optimisticMessageId: String? = null
                ) {
                    val agentId = selectedAgentId ?: run {
                        status = "Select a Mac"
                        return
                    }
                    val requestId = "android-${UUID.randomUUID()}"
                    val responseKey = when (method) {
                        "sessions.list" -> "$method:$agentId"
                        "sessions.read" -> "$method:$agentId:$sessionId"
                        else -> null
                    }
                    pendingRequests[requestId] = RpcContext(
                        method = method,
                        agentId = agentId,
                        sessionId = sessionId,
                        optimisticMessageId = optimisticMessageId,
                        responseKey = responseKey
                    )
                    responseKey?.let { latestRequests[it] = requestId }
                    if (relay.rpc(method, params, requestId) == null) {
                        pendingRequests.remove(requestId)
                        if (responseKey != null && latestRequests[responseKey] == requestId) {
                            latestRequests.remove(responseKey)
                        }
                        optimisticMessageId?.let { markMessage(it, DeliveryState.Failed) }
                    }
                    mainHandler.postDelayed({
                        val context = pendingRequests.remove(requestId) ?: return@postDelayed
                        if (context.responseKey != null && latestRequests[context.responseKey] != requestId) return@postDelayed
                        context.responseKey?.let { latestRequests.remove(it) }
                        if (context.agentId != selectedAgentId) return@postDelayed
                        if (context.sessionId != null && context.sessionId != selectedSessionId) return@postDelayed
                        context.optimisticMessageId?.let { markMessage(it, DeliveryState.Failed) }
                        status = "Request timed out"
                    }, REQUEST_TIMEOUT_MS)
                }

                fun handleRpcResponse(body: JSONObject) {
                    val requestId = body.optString("requestId")
                    val context = pendingRequests.remove(requestId) ?: return
                    if (context.agentId != selectedAgentId) return
                    if (context.sessionId != null && context.sessionId != selectedSessionId) return
                    if (context.responseKey != null && latestRequests[context.responseKey] != requestId) return
                    context.responseKey?.let { latestRequests.remove(it) }

                    if (!body.optBoolean("ok")) {
                        context.optimisticMessageId?.let { markMessage(it, DeliveryState.Failed) }
                        status = body.optString("error", "Request failed")
                        return
                    }

                    when (context.method) {
                        "sessions.list" -> {
                            val result = body.opt("result") as? JSONArray ?: return
                            sessions.clear()
                            for (i in 0 until result.length()) {
                                sessions.add(result.getJSONObject(i).toSessionRow())
                            }
                            status = "${sessions.size} sessions"
                        }
                        "sessions.read" -> {
                            val result = body.opt("result") as? JSONObject ?: return
                            if (!result.has("messages")) return
                            val session = result.optJSONObject("session")
                            activeTurnId = session?.optString("activeTurnId")?.ifBlank { null }
                            messages.clear()
                            val array = result.getJSONArray("messages")
                            for (i in 0 until array.length()) {
                                messages.add(array.getJSONObject(i).toChatMessage())
                            }
                            status = "${messages.size} messages"
                        }
                        "sessions.send" -> {
                            context.optimisticMessageId?.let { markMessage(it, DeliveryState.Sent) }
                            status = "Sent · refreshing"
                            context.sessionId?.let {
                                sendRpc("sessions.read", JSONObject().put("sessionId", it), it)
                            }
                        }
                        "turn.interrupt" -> {
                            activeTurnId = null
                            status = "Stopped · refreshing"
                            context.sessionId?.let {
                                sendRpc("sessions.read", JSONObject().put("sessionId", it), it)
                            }
                        }
                    }
                }

                relay = remember {
                    RelayClient(
                        cryptoBox = cryptoBox,
                        androidId = androidId,
                        androidName = androidName,
                        onEvent = { runOnUiThread { status = it } },
                        onConnected = {
                            runOnUiThread {
                                status = "Online · ${it.agentName}"
                                if (it.agentId == selectedAgentId) {
                                    sendRpc("sessions.list")
                                }
                            }
                        },
                        onRpcResponse = { body -> runOnUiThread { handleRpcResponse(body) } }
                    )
                }

                DisposableEffect(Unit) {
                    onDispose { relay.disconnect() }
                }

                fun addAgent(uri: String) {
                    runCatching {
                        val cleanUri = uri.trim()
                        val pairing = parsePairingUri(cleanUri)
                        agents.removeAll { it.pairing.agentId == pairing.agentId }
                        val record = PairingRecord(cleanUri, pairing)
                        agents.add(0, record)
                        pairingText = ""
                        showPairingEditor = false
                        connect(record)
                    }.onFailure {
                        status = it.message ?: "Pairing failed"
                    }
                }

                fun removeSelectedAgent() {
                    val current = selectedAgentId ?: return
                    agents.removeAll { it.pairing.agentId == current }
                    selectedAgentId = agents.firstOrNull()?.pairing?.agentId
                    resetThreadView()
                    saveAgents()
                    val next = selectedAgent()
                    if (next == null) {
                        relay.disconnect()
                        status = "Offline"
                        showPairingEditor = true
                    } else {
                        connect(next)
                    }
                }

                LaunchedEffect(Unit) {
                    selectedAgent()?.let { connect(it) }
                }

                RemoteConsoleScreen(
                    agents = agents,
                    selectedAgentId = selectedAgentId,
                    status = status,
                    sessions = sessions,
                    messages = messages,
                    selectedSessionId = selectedSessionId,
                    activeTurnId = activeTurnId,
                    pairingText = pairingText,
                    showPairingEditor = showPairingEditor,
                    input = input,
                    onPairingTextChange = { pairingText = it },
                    onTogglePairingEditor = { showPairingEditor = !showPairingEditor },
                    onAddAgent = { addAgent(pairingText) },
                    onRemoveAgent = ::removeSelectedAgent,
                    onSelectAgent = { record -> connect(record) },
                    onRefresh = { sendRpc("sessions.list") },
                    onSelectSession = { session ->
                        selectedSessionId = session.id
                        activeTurnId = null
                        messages.clear()
                        status = "Loading ${session.shortTitle}"
                        sendRpc(
                            method = "sessions.read",
                            params = JSONObject().put("sessionId", session.id),
                            sessionId = session.id
                        )
                    },
                    onInputChange = { input = it },
                    onSend = {
                        val sessionId = selectedSessionId ?: return@RemoteConsoleScreen
                        val text = input.trim()
                        if (text.isBlank()) return@RemoteConsoleScreen
                        val optimisticMessage = ChatMessage(
                            id = "local-${UUID.randomUUID()}",
                            role = "user",
                            text = text,
                            deliveryState = DeliveryState.Sending
                        )
                        messages.add(optimisticMessage)
                        val params = JSONObject().put("sessionId", sessionId).put("text", text)
                        activeTurnId?.let { params.put("activeTurnId", it) }
                        sendRpc(
                            method = "sessions.send",
                            params = params,
                            sessionId = sessionId,
                            optimisticMessageId = optimisticMessage.id
                        )
                        input = ""
                        status = "Sending"
                    },
                    onStopTurn = {
                        val sessionId = selectedSessionId ?: return@RemoteConsoleScreen
                        val turnId = activeTurnId ?: return@RemoteConsoleScreen
                        sendRpc(
                            method = "turn.interrupt",
                            params = JSONObject().put("sessionId", sessionId).put("turnId", turnId),
                            sessionId = sessionId
                        )
                        status = "Stopping"
                    }
                )
            }
        }
    }
}

@Composable
private fun RemoteConsoleScreen(
    agents: List<PairingRecord>,
    selectedAgentId: String?,
    status: String,
    sessions: List<SessionRow>,
    messages: List<ChatMessage>,
    selectedSessionId: String?,
    activeTurnId: String?,
    pairingText: String,
    showPairingEditor: Boolean,
    input: String,
    onPairingTextChange: (String) -> Unit,
    onTogglePairingEditor: () -> Unit,
    onAddAgent: () -> Unit,
    onRemoveAgent: () -> Unit,
    onSelectAgent: (PairingRecord) -> Unit,
    onRefresh: () -> Unit,
    onSelectSession: (SessionRow) -> Unit,
    onInputChange: (String) -> Unit,
    onSend: () -> Unit,
    onStopTurn: () -> Unit
) {
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 14.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Header(status = status, onRefresh = onRefresh)
            AgentRail(
                agents = agents,
                selectedAgentId = selectedAgentId,
                onSelectAgent = onSelectAgent,
                onTogglePairingEditor = onTogglePairingEditor,
                onRemoveAgent = onRemoveAgent
            )
            if (showPairingEditor) {
                PairingEditor(
                    value = pairingText,
                    onValueChange = onPairingTextChange,
                    onAddAgent = onAddAgent,
                    onClose = onTogglePairingEditor
                )
            }
            ConsoleBody(
                sessions = sessions,
                messages = messages,
                selectedSessionId = selectedSessionId,
                onSelectSession = onSelectSession,
                modifier = Modifier.weight(1f)
            )
            ComposerBar(
                value = input,
                enabled = selectedSessionId != null,
                isActiveTurn = activeTurnId != null,
                onValueChange = onInputChange,
                onSend = onSend,
                onStopTurn = onStopTurn
            )
        }
    }
}

@Composable
private fun Header(status: String, onRefresh: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Surface(
            modifier = Modifier.size(42.dp),
            shape = RoundedCornerShape(8.dp),
            color = Color(0xFF13201E)
        ) {
            Box(contentAlignment = Alignment.Center) {
                Text("CR", color = Color(0xFFFFFCF4), fontWeight = FontWeight.Bold)
            }
        }
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(
                text = "Codex Remote",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(7.dp)
                        .clip(CircleShape)
                        .background(if (status.startsWith("Online") || status.contains("sessions") || status.contains("messages")) Color(0xFF1F8F5F) else Color(0xFFE4572E))
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    text = status,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }
        OutlinedButton(
            onClick = onRefresh,
            shape = RoundedCornerShape(8.dp),
            contentPadding = PaddingValues(horizontal = 12.dp)
        ) {
            Text("Refresh")
        }
    }
}

@Composable
private fun AgentRail(
    agents: List<PairingRecord>,
    selectedAgentId: String?,
    onSelectAgent: (PairingRecord) -> Unit,
    onTogglePairingEditor: () -> Unit,
    onRemoveAgent: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        agents.forEach { record ->
            val selected = record.pairing.agentId == selectedAgentId
            Surface(
                modifier = Modifier
                    .height(40.dp)
                    .clickable { onSelectAgent(record) },
                shape = RoundedCornerShape(8.dp),
                color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surface,
                border = BorderStroke(1.dp, if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline)
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 12.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = record.pairing.agentName,
                        color = if (selected) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface,
                        style = MaterialTheme.typography.labelLarge,
                        maxLines = 1
                    )
                }
            }
        }
        OutlinedButton(
            onClick = onTogglePairingEditor,
            shape = RoundedCornerShape(8.dp),
            contentPadding = PaddingValues(horizontal = 12.dp)
        ) {
            Text("+ Mac")
        }
        if (selectedAgentId != null) {
            TextButton(onClick = onRemoveAgent) {
                Text("Remove")
            }
        }
    }
}

@Suppress("DEPRECATION")
@Composable
private fun PairingEditor(
    value: String,
    onValueChange: (String) -> Unit,
    onAddAgent: () -> Unit,
    onClose: () -> Unit
) {
    val clipboard = LocalClipboardManager.current
    Surface(
        shape = RoundedCornerShape(8.dp),
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Pair Mac", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                TextButton(onClick = onClose) {
                    Text("Close")
                }
            }
            OutlinedTextField(
                value = value,
                onValueChange = onValueChange,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 92.dp),
                label = { Text("Pairing URI") },
                maxLines = 4
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    onClick = { clipboard.getText()?.text?.let(onValueChange) },
                    shape = RoundedCornerShape(8.dp)
                ) {
                    Text("Paste")
                }
                Button(
                    onClick = onAddAgent,
                    enabled = value.trim().startsWith("codexrc://pair/"),
                    shape = RoundedCornerShape(8.dp)
                ) {
                    Text("Add")
                }
            }
        }
    }
}

@Composable
private fun ConsoleBody(
    sessions: List<SessionRow>,
    messages: List<ChatMessage>,
    selectedSessionId: String?,
    onSelectSession: (SessionRow) -> Unit,
    modifier: Modifier = Modifier
) {
    BoxWithConstraints(modifier.fillMaxSize()) {
        val wide = maxWidth > 680.dp
        if (wide) {
            Row(
                modifier = Modifier.fillMaxSize(),
                horizontalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                SessionList(
                    sessions = sessions,
                    selectedSessionId = selectedSessionId,
                    onSelectSession = onSelectSession,
                    modifier = Modifier.weight(0.42f)
                )
                MessageStream(messages = messages, modifier = Modifier.weight(0.58f))
            }
        } else {
            Column(
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                SessionList(
                    sessions = sessions,
                    selectedSessionId = selectedSessionId,
                    onSelectSession = onSelectSession,
                    modifier = Modifier.weight(0.42f)
                )
                MessageStream(messages = messages, modifier = Modifier.weight(0.58f))
            }
        }
    }
}

@Composable
private fun SessionList(
    sessions: List<SessionRow>,
    selectedSessionId: String?,
    onSelectSession: (SessionRow) -> Unit,
    modifier: Modifier = Modifier
) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(8.dp),
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)
    ) {
        Column {
            SectionHeader(title = "Sessions", meta = sessions.size.toString())
            if (sessions.isEmpty()) {
                EmptyState("No sessions loaded")
            } else {
                LazyColumn {
                    items(sessions, key = { it.id }) { session ->
                        SessionRowItem(
                            session = session,
                            selected = session.id == selectedSessionId,
                            onClick = { onSelectSession(session) }
                        )
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    }
                }
            }
        }
    }
}

@Composable
private fun SessionRowItem(session: SessionRow, selected: Boolean, onClick: () -> Unit) {
    val background = if (selected) Color(0xFFE3F4EE) else Color.Transparent
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(background)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.Top
    ) {
        Box(
            modifier = Modifier
                .padding(top = 5.dp)
                .size(8.dp)
                .clip(CircleShape)
                .background(if (selected) MaterialTheme.colorScheme.primary else Color(0xFFB9C0B4))
        )
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(
                text = session.shortTitle,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            if (session.preview.isNotBlank()) {
                Text(
                    text = session.preview,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = session.cwdName,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.secondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )
                Text(
                    text = session.updatedLabel,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

@Composable
private fun MessageStream(messages: List<ChatMessage>, modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(8.dp),
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)
    ) {
        Column {
            SectionHeader(title = "Thread", meta = messages.size.toString())
            if (messages.isEmpty()) {
                EmptyState("Select a session")
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(12.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    items(messages) { message ->
                        MessageBubble(message)
                    }
                }
            }
        }
    }
}

@Composable
private fun MessageBubble(message: ChatMessage) {
    val isUser = message.role == "user"
    val bubbleColor = when (message.role) {
        "user" -> MaterialTheme.colorScheme.primary
        "tool", "reasoning" -> Color(0xFFFFF3D7)
        else -> Color(0xFFF1F4EC)
    }
    val textColor = if (isUser) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start
    ) {
        Surface(
            modifier = Modifier.fillMaxWidth(if (isUser) 0.86f else 0.94f),
            shape = RoundedCornerShape(8.dp),
            color = bubbleColor
        ) {
            Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = message.role.uppercase(Locale.getDefault()),
                        style = MaterialTheme.typography.labelSmall,
                        color = if (isUser) Color(0xFFD8F4EC) else MaterialTheme.colorScheme.secondary,
                        fontWeight = FontWeight.Bold
                    )
                    if (message.deliveryState != DeliveryState.Sent) {
                        Spacer(Modifier.width(8.dp))
                        Text(
                            text = if (message.deliveryState == DeliveryState.Sending) "SENDING" else "FAILED",
                            style = MaterialTheme.typography.labelSmall,
                            color = if (message.deliveryState == DeliveryState.Failed) Color(0xFFE4572E) else Color(0xFF7A7F73),
                            fontWeight = FontWeight.Bold
                        )
                    }
                }
                Spacer(Modifier.height(4.dp))
                Text(
                    text = message.text,
                    style = MaterialTheme.typography.bodyMedium,
                    color = textColor
                )
            }
        }
    }
}

@Composable
private fun ComposerBar(
    value: String,
    enabled: Boolean,
    isActiveTurn: Boolean,
    onValueChange: (String) -> Unit,
    onSend: () -> Unit,
    onStopTurn: () -> Unit
) {
    Surface(
        shape = RoundedCornerShape(8.dp),
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)
    ) {
        Row(
            modifier = Modifier.padding(8.dp),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            OutlinedTextField(
                value = value,
                onValueChange = onValueChange,
                modifier = Modifier.weight(1f),
                enabled = enabled,
                label = { Text(if (enabled) "Message" else "Select a session") },
                minLines = 1,
                maxLines = 4
            )
            if (isActiveTurn) {
                OutlinedButton(
                    onClick = onStopTurn,
                    enabled = enabled,
                    shape = RoundedCornerShape(8.dp),
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 14.dp)
                ) {
                    Text("Stop")
                }
            }
            Button(
                onClick = onSend,
                enabled = enabled && value.isNotBlank(),
                shape = RoundedCornerShape(8.dp),
                contentPadding = PaddingValues(horizontal = 14.dp, vertical = 14.dp)
            ) {
                Text(if (isActiveTurn) "Steer" else "Send")
            }
        }
    }
}

@Composable
private fun SectionHeader(title: String, meta: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.weight(1f))
        Text(meta, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
}

@Composable
private fun EmptyState(text: String) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(24.dp),
        contentAlignment = Alignment.Center
    ) {
        Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun ConsoleTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = lightColorScheme(
            primary = Color(0xFF0F766E),
            onPrimary = Color.White,
            secondary = Color(0xFFE4572E),
            background = Color(0xFFF4F6F0),
            surface = Color(0xFFFFFEFA),
            onSurface = Color(0xFF1E211B),
            onSurfaceVariant = Color(0xFF62685D),
            outline = Color(0xFFD3D8CE),
            outlineVariant = Color(0xFFE5E8DF)
        ),
        typography = MaterialTheme.typography.copy(
            titleLarge = MaterialTheme.typography.titleLarge.copy(fontFamily = FontFamily.SansSerif),
            titleMedium = MaterialTheme.typography.titleMedium.copy(fontFamily = FontFamily.SansSerif),
            bodyMedium = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.SansSerif)
        ),
        content = content
    )
}

private data class PairingRecord(val uri: String, val pairing: Pairing)

private data class RpcContext(
    val method: String,
    val agentId: String,
    val sessionId: String? = null,
    val optimisticMessageId: String? = null,
    val responseKey: String? = null
)

private data class SessionRow(
    val id: String,
    val title: String,
    val preview: String,
    val cwd: String,
    val updatedAt: Long
) {
    val shortTitle: String = title.ifBlank { id }
    val cwdName: String = cwd.substringAfterLast("/").ifBlank { cwd.ifBlank { "workspace" } }
    val updatedLabel: String = formatTimestamp(updatedAt)
}

private enum class DeliveryState {
    Sent,
    Sending,
    Failed
}

private data class ChatMessage(
    val id: String,
    val role: String,
    val text: String,
    val deliveryState: DeliveryState = DeliveryState.Sent
)

private fun JSONObject.toSessionRow(): SessionRow {
    return SessionRow(
        id = getString("id"),
        title = optString("title"),
        preview = optString("preview"),
        cwd = optString("cwd"),
        updatedAt = optLong("updatedAt")
    )
}

private fun JSONObject.toChatMessage(): ChatMessage {
    return ChatMessage(
        id = optString("id").ifBlank { "remote-${System.nanoTime()}" },
        role = optString("role", "assistant"),
        text = optString("text")
    )
}

private fun loadPairingRecords(preferences: SharedPreferences): List<PairingRecord> {
    val uris = mutableListOf<String>()
    preferences.getString(PREF_PAIRING_URIS, null)?.let { raw ->
        runCatching {
            val array = JSONArray(raw)
            for (i in 0 until array.length()) {
                uris.add(array.getJSONObject(i).getString("uri"))
            }
        }
    }
    val legacy = preferences.getString(PREF_LEGACY_PAIRING_URI, "") ?: ""
    if (legacy.isNotBlank() && legacy !in uris) {
        uris.add(legacy)
    }
    return uris.distinct().mapNotNull { uri ->
        runCatching { PairingRecord(uri, parsePairingUri(uri)) }.getOrNull()
    }
}

private fun savePairingRecords(
    preferences: SharedPreferences,
    records: List<PairingRecord>,
    selectedAgentId: String?
) {
    val array = JSONArray()
    records.forEach { array.put(JSONObject().put("uri", it.uri)) }
    preferences.edit()
        .putString(PREF_PAIRING_URIS, array.toString())
        .putString(PREF_SELECTED_AGENT_ID, selectedAgentId)
        .putString(PREF_LEGACY_PAIRING_URI, records.firstOrNull()?.uri ?: "")
        .apply()
}

private fun formatTimestamp(ms: Long): String {
    if (ms <= 0L) return "--"
    return SimpleDateFormat("MM/dd HH:mm", Locale.getDefault()).format(Date(ms))
}
