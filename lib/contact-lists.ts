import type { IdentityProfile } from "@/lib/identity-client"

/**
 * People who can be messaged but are not in the outgoing follow list.
 *
 * The DM picker shows outgoing follows first, then one-way followers, so an
 * incoming message can be answered without typing an address. A profile that
 * appears in both lists is shown once, in the outgoing group.
 */
export function followersNotFollowed(own: IdentityProfile, following: IdentityProfile[], followers: IdentityProfile[]): IdentityProfile[] {
  const known = new Set(following.map(person => person.id))
  const seen = new Set<string>([own.id])
  const result: IdentityProfile[] = []
  for (const person of followers) {
    if (known.has(person.id) || seen.has(person.id)) continue
    seen.add(person.id)
    result.push(person)
  }
  return result
}
