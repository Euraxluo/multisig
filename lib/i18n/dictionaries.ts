import type { Locale } from "./locale-store"
import { common } from "./dictionaries/common"
import { shell } from "./dictionaries/shell"
import { dash } from "./dictionaries/dash"
import { tx } from "./dictionaries/tx"
import { profile } from "./dictionaries/profile"
import { privacy } from "./dictionaries/privacy"
import { groups } from "./dictionaries/groups"
import { dkg } from "./dictionaries/dkg"
import { voting } from "./dictionaries/voting"
import { walrus } from "./dictionaries/walrus"
import { payments } from "./dictionaries/payments"
import { agents } from "./dictionaries/agents"
import { vault } from "./dictionaries/vault"
import { misc } from "./dictionaries/misc"

/**
 * All domains flattened to `"<domain>.<key>"` per locale. A domain file owns its
 * keys exclusively — extraction agents must only ever edit their own domain
 * file, never this index, and never another bundle's domain.
 */
const domains: Record<string, import("./types").Domain> = {
  common,
  shell,
  dash,
  tx,
  profile,
  privacy,
  groups,
  dkg,
  voting,
  walrus,
  payments,
  agents,
  vault,
  misc,
}

export type MessageTable = Record<string, string>

export const messages: Record<Locale, MessageTable> = { en: {}, zh: {} }

for (const [name, domain] of Object.entries(domains)) {
  for (const locale of ["en", "zh"] as const) {
    for (const [key, value] of Object.entries(domain[locale])) {
      messages[locale][`${name}.${key}`] = value
    }
  }
}
