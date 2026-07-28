package app.varmlen.client

internal enum class VpnRequestKind {
    CONNECT,
    DISCONNECT,
}

internal enum class VpnRequestOutcome {
    IGNORE,
    RESOLVE,
    REJECT,
}

internal fun vpnRequestOutcome(
    kind: VpnRequestKind,
    pendingRequestId: String,
    broadcastRequestId: String?,
    running: Boolean,
): VpnRequestOutcome {
    if (broadcastRequestId == null || broadcastRequestId != pendingRequestId) {
        return VpnRequestOutcome.IGNORE
    }
    return when (kind) {
        VpnRequestKind.CONNECT ->
            if (running) VpnRequestOutcome.RESOLVE else VpnRequestOutcome.REJECT
        VpnRequestKind.DISCONNECT ->
            if (running) VpnRequestOutcome.IGNORE else VpnRequestOutcome.RESOLVE
    }
}
