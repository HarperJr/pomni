import { z } from 'zod';
import type { AddressKind, ParsedAddress } from './address-rule.js';

/**
 * The schema half of addressing. The rule itself — what counts as `#project`, `@agent` or
 * `/skill`, and how it comes back out of the prose — is in `address-rule.ts` and is re-exported
 * whole from here, so every existing import path still reaches it.
 *
 * The split is not tidiness. `packages/web` cannot depend on `@pomni/core` and had a
 * hand-copied duplicate of the rule; a file with no zod in it is one the composer can alias
 * instead of copy. Only what is *persisted* needs a schema, and that is this file: a stored
 * address arrives from a database row or an HTTP body and has to be checked, while a candidate
 * found in a draft was produced by the parser a moment ago and cannot be malformed.
 */

export * from './address-rule.js';

export const AddressKindSchema = z.enum(['project', 'agent', 'skill']);

/**
 * A resolved address, as recorded on the message that carried it.
 *
 * Deliberately smaller than `ParsedAddress`: offsets describe one draft in one composer and are
 * meaningless once the text is stored, while `kind`/`workflowId`/`name` are the fact about what
 * the message was aimed at. A stored chip re-renders from these three.
 */
export const MessageAddressSchema = z.object({
  kind: AddressKindSchema,
  /** The name after the sigil, lowercased. For an agent, the agent id alone. */
  name: z.string().min(1),
  /** `@workflow/agent` only. Null for the bare `@agent` form, and for every other kind. */
  workflowId: z.string().nullable().default(null),
});
export type MessageAddress = z.infer<typeof MessageAddressSchema>;

/**
 * The two halves agree by construction: a `ParsedAddress` is a `MessageAddress` with offsets.
 * `ParsedAddress` can no longer say so with `extends`, because the schema it would extend is the
 * zod that must not reach the composer — so the claim is checked here instead of assumed.
 */
type Assert<T extends true> = T;

export type ParsedAddressIsStorable = Assert<ParsedAddress extends MessageAddress ? true : false>;

/** And the kinds are the same three, however each half spells them. */
export type AddressKindsAgree = Assert<
  [AddressKind] extends [z.infer<typeof AddressKindSchema>]
    ? [z.infer<typeof AddressKindSchema>] extends [AddressKind]
      ? true
      : false
    : false
>;
