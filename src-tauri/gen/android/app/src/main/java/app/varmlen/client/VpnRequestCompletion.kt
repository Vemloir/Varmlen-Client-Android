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
    error: String? = null,
): VpnRequestOutcome {
    if (broadcastRequestId == null || broadcastRequestId != pendingRequestId) {
        return VpnRequestOutcome.IGNORE
    }
    return when (kind) {
        VpnRequestKind.CONNECT ->
            // A refused RECONFIGURE arrives with running = true: the tunnel the user
            // already had is still up, and this request is the one that failed. The
            // session and the request are two different facts, and answering "done"
            // because a tunnel exists would tell the app its edit applied.
            if (error != null) VpnRequestOutcome.REJECT
            else if (running) VpnRequestOutcome.RESOLVE else VpnRequestOutcome.REJECT
        VpnRequestKind.DISCONNECT ->
            if (running) VpnRequestOutcome.IGNORE else VpnRequestOutcome.RESOLVE
    }
}
