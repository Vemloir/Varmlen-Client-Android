package app.varmlen.client

internal data class VpnAppPolicy(
    val allowed: List<String>,
    val disallowed: List<String>
)

internal fun vpnAppPolicy(
    packages: Array<String>,
    allowlist: Boolean,
    ownerPackage: String
): VpnAppPolicy {
    val selected = packages
        .asSequence()
        .map(String::trim)
        .filter(String::isNotEmpty)
        .distinct()
        .toList()

    if (allowlist) {
        require(selected.isNotEmpty()) {
            "Selective app mode requires at least one installed application"
        }
        return VpnAppPolicy(allowed = selected, disallowed = emptyList())
    }

    return VpnAppPolicy(
        allowed = emptyList(),
        disallowed = (selected + ownerPackage).distinct()
    )
}
