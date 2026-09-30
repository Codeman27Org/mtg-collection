import * as nip44 from 'nostr-tools/nip44';

/** NIP-44 v2 with a raw 32-byte conversation key (self-key or share key). */
export function encryptJson(obj, conversationKey) {
  return nip44.encrypt(JSON.stringify(obj), conversationKey);
}

export function decryptJson(payload, conversationKey) {
  return JSON.parse(nip44.decrypt(payload, conversationKey));
}

export function selfConversationKey(sk, pubkey) {
  return nip44.getConversationKey(sk, pubkey);
}
