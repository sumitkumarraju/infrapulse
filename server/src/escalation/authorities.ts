import type { Authority, AuthorityKind } from '@shared/escalation'

/* Who receives a road complaint.
 *
 * Indian roads are owned by different bodies depending on their class: national
 * highways by NHAI, state highways and major district roads by the state PWD
 * (Buildings & Roads), and everything else by the municipal corporation or
 * council. A complaint sent to the wrong one is forwarded at best and ignored
 * at worst.
 *
 * THE ADDRESSES ARE DELIBERATELY EMPTY.
 *
 * Publishing a guessed address for a public office would be worse than having
 * none: mail would vanish, or worse, reach someone it should not. These must be
 * filled in from the actual jurisdiction's published contacts before anything
 * can be sent, and `isDeliverable` below refuses until they are.
 *
 * Set them with environment variables:
 *   AUTHORITY_NATIONAL_EMAIL, AUTHORITY_NATIONAL_NAME
 *   AUTHORITY_STATE_EMAIL,    AUTHORITY_STATE_NAME
 *   AUTHORITY_MUNICIPAL_EMAIL, AUTHORITY_MUNICIPAL_NAME
 */

function read(kind: string, fallbackName: string, portal?: string): Authority {
  const upper = kind.toUpperCase()
  return {
    kind: kind as AuthorityKind,
    name: process.env[`AUTHORITY_${upper}_NAME`] ?? fallbackName,
    email: process.env[`AUTHORITY_${upper}_EMAIL`] ?? '',
    portal: process.env[`AUTHORITY_${upper}_PORTAL`] ?? portal,
  }
}

export function authorities(): Record<AuthorityKind, Authority> {
  return {
    // Names describe the office rather than naming an individual, so a draft
    // does not go stale when someone is transferred.
    national: read(
      'national',
      'The Project Director, National Highways Authority of India',
    ),
    state: read(
      'state',
      'The Executive Engineer, Public Works Department (Buildings & Roads)',
    ),
    municipal: read('municipal', 'The Commissioner, Municipal Corporation'),
  }
}

/** True once a real address has been configured for this authority. */
export function isDeliverable(authority: Authority): boolean {
  return authority.email.trim().length > 0 && authority.email.includes('@')
}
