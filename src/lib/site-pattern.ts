/**
 * Notation and input normalisation for website rules.
 *
 * There is no asterisk in this notation. `*.google.com` loses both audiences: a
 * person who does not know the syntax sees junk in front of the name and thinks it
 * is not Google, and a person who reads it as a glob concludes the apex is excluded
 * because of the dot. So the plain form carries the meaning most people mean:
 *
 *   - `google.com`   the host and everything under it  -> xray `domain:google.com`
 *   - `.ru`          a whole zone                       -> xray `domain:ru`
 *   - `=google.com`  this host only, for whoever types it that way -> `full:google.com`
 *
 * xray's `domain:` matcher is a label-aligned suffix match -- it matches the name
 * itself and any subdomain, and not `notgoogle.com` -- so the plain form covers the
 * apex too. The legacy `*.host` spelling is still accepted on input and normalises
 * to the plain form; the router maps it to the same rule either way.
 */

export type SiteRuleKind = "suffix" | "zone" | "exact";

/**
 * Clean what was typed into a stored pattern: surrounding space, a scheme, a path,
 * a query, a fragment, the `user@` of a URL with credentials, and the trailing dot
 * of a fully qualified name. Someone pasting `https://example.com/vpn` means
 * `example.com`, and storing the pasted string would create a rule that matches
 * nothing and silently does nothing -- a lie inside our own feature.
 *
 * The notation is resolved here so that one meaning has one spelling: the legacy
 * `*.host` becomes `host`, a `.host` that names a whole domain becomes `host`, and
 * only a single-label zone keeps its leading dot.
 */
export function normalizeSitePattern(value: string): string {
  let v = value.trim().toLowerCase();
  if (!v) return "";
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  v = v.split(/[/?#]/)[0];
  const at = v.lastIndexOf("@");
  if (at >= 0) v = v.slice(at + 1);
  v = v.replace(/\.+$/, "").trim();
  if (!v) return "";

  let exact = false;
  if (v.startsWith("=")) {
    exact = true;
    v = v.slice(1);
  }
  let dotted = false;
  if (v.startsWith("*.")) v = v.slice(2); // the legacy spelling of the plain form
  else if (v.startsWith(".")) {
    dotted = true;
    v = v.slice(1);
  }
  v = v.replace(/\.+$/, "");

  if (exact) return `=${v}`;
  // A name with a dot is a whole domain, and the plain form already means "this
  // domain and everything under it", so a dot in front of it adds nothing.
  if (v.includes(".")) return v;
  if (dotted) return `.${v}`;
  // Bare and short: "ru" is the zone people mean. Bare and long is a name with a
  // dot forgotten, which validation reports instead of guessing into a zone.
  return v.length >= 2 && v.length <= 3 ? `.${v}` : v;
}

/** Which of the three meanings a stored pattern carries. */
export function siteRuleKind(pattern: string): SiteRuleKind {
  if (pattern.startsWith("=")) return "exact";
  if (pattern.startsWith(".")) return "zone";
  return "suffix";
}

/** The i18n key that says in words what the pattern means. */
export function siteKindLabelKey(kind: SiteRuleKind): string {
  if (kind === "exact") return "split.siteKindExact";
  if (kind === "zone") return "split.siteKindZone";
  return "split.siteKindSuffix";
}

/**
 * A host, a zone, or an explicitly exact host. A port is refused rather than
 * dropped: the router matches domains, so `example.com:8080` cannot mean anything
 * here, and quietly turning it into `example.com` would hide a misunderstanding.
 */
export function isSitePattern(value: string): boolean {
  const v = normalizeSitePattern(value);
  if (!v) return false;
  const kind = siteRuleKind(v);
  const host = kind === "suffix" ? v : v.slice(1);
  if (!host) return false;
  const labels = host.split(".");
  if (labels.some((label) => !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label))) return false;
  // No registered top-level label is a single character, so `example.c` is a
  // mistake, not a domain.
  if (labels[labels.length - 1].length < 2) return false;
  // Only a zone may name a single label; a host has to be a whole domain.
  return kind === "zone" || labels.length >= 2;
}

/**
 * Rewrite stored patterns into the current notation. Semantics are unchanged (the
 * router maps both spellings to the same rule), so this is a display fix, not a
 * routing change.
 */
export function migrateSitePatterns<T extends { pattern: string }>(
  sites: T[],
): { sites: T[]; changed: boolean } {
  let changed = false;
  const next = sites.map((site) => {
    const pattern = normalizeSitePattern(site.pattern);
    if (!pattern || pattern === site.pattern) return site;
    changed = true;
    return { ...site, pattern };
  });
  return { sites: next, changed };
}