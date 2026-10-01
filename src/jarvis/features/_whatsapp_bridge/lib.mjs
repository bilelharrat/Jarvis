// What bridge.mjs sends Jarvis about chats, contacts and messages: plain JSON, shaped here so
// it can be checked without a WhatsApp connection.

import { getContentType, isJidGroup, jidNormalizedUser, normalizeMessageContent } from '@whiskeysockets/baileys';

export const TEXT_LIMIT = 4000;

export function num(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  if (typeof value.toNumber === 'function') return value.toNumber();
  return Number(value) || 0;
}

export function norm(jid) {
  if (!jid || typeof jid !== 'string') return null;
  try {
    return jidNormalizedUser(jid) || null;
  } catch {
    return null;
  }
}

// What a message says, as text: a caption or a [photo]-style note for what isn't text; null
// for what isn't a message someone wrote (reactions, receipts, key exchanges, edits' shells).
export function textOf(message) {
  const content = normalizeMessageContent(message);
  const type = content && getContentType(content);
  if (!type) return null;
  const m = content[type] || {};
  const captioned = (label) => (m.caption ? `[${label}] ${m.caption}` : `[${label}]`);
  switch (type) {
    case 'conversation': return content.conversation || null;
    case 'extendedTextMessage': return m.text || null;
    case 'imageMessage': return captioned('photo');
    case 'videoMessage': return captioned(m.gifPlayback ? 'GIF' : 'video');
    case 'ptvMessage': return '[video message]';
    case 'audioMessage': return m.ptt ? '[voice message]' : '[audio]';
    case 'documentMessage': return m.caption ? `[document: ${m.fileName || 'file'}] ${m.caption}` : `[document: ${m.fileName || 'file'}]`;
    case 'stickerMessage': return '[sticker]';
    case 'locationMessage': return `[location${m.name ? `: ${m.name}` : ''}]`;
    case 'liveLocationMessage': return '[live location]';
    case 'contactMessage': return `[contact: ${m.displayName || ''}]`;
    case 'contactsArrayMessage': return '[contacts]';
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3': return `[poll: ${m.name || ''}]`;
    case 'eventMessage': return `[event: ${m.name || ''}]`;
    default: return null;
  }
}

// What a message replies to and whom it mentions (its contextInfo), for Jarvis's chat
// channel: the quoted message's id, author and words, and the mentioned addresses.
export function contextOf(message) {
  const content = normalizeMessageContent(message);
  const type = content && getContentType(content);
  const info = type && content[type] && typeof content[type] === 'object' ? content[type].contextInfo : null;
  if (!info) return {};
  const out = {};
  if (info.stanzaId) {
    out.quoted_id = String(info.stanzaId);
    out.quoted_sender = norm(info.participant);
    const said = info.quotedMessage ? textOf(info.quotedMessage) : null;
    if (said != null) out.quoted_text = String(said).slice(0, TEXT_LIMIT);
  }
  const mentions = (info.mentionedJid || []).map(norm).filter(Boolean);
  if (mentions.length) out.mentions = mentions.slice(0, 50);
  return out;
}

// own: the ids of the messages Jarvis itself sent (never read back as the owner's).
export function brief(msg, own) {
  const key = msg && msg.key;
  const chat = norm(key && key.remoteJid);
  if (!chat || chat === 'status@broadcast' || chat.endsWith('@newsletter')) return null;
  const text = textOf(msg.message);
  if (text == null) return null;
  const group = Boolean(isJidGroup(chat));
  const content = normalizeMessageContent(msg.message);
  const type = content && getContentType(content);
  return {
    ...contextOf(msg.message),
    kind: type === 'conversation' || type === 'extendedTextMessage' ? 'text' : 'media',
    jarvis: Boolean(own && own.has(key.id)),
    id: key.id,
    chat,
    chat_alt: norm(key.remoteJidAlt),
    from_me: Boolean(key.fromMe),
    sender: group ? norm(key.participant) : key.fromMe ? null : chat,
    sender_alt: group ? norm(key.participantAlt) : key.fromMe ? null : norm(key.remoteJidAlt),
    name: msg.pushName || null,
    ts: num(msg.messageTimestamp),
    text: String(text).slice(0, TEXT_LIMIT),
  };
}

export function chatOf(c) {
  const id = norm(c && c.id);
  if (!id || id === 'status@broadcast') return null;
  const chat = { id };
  if (c.name) chat.name = c.name;
  if (c.unreadCount != null) chat.unread = num(c.unreadCount);
  const ts = num(c.conversationTimestamp) || num(c.lastMessageRecvTimestamp);
  if (ts) chat.ts = ts;
  if (c.archived != null) chat.archived = Boolean(c.archived);
  return chat;
}

export function contactOf(c) {
  const id = norm(c && c.id);
  if (!id) return null;
  return {
    id,
    lid: norm(c.lid),
    pn: norm(c.phoneNumber),
    name: c.name || null,
    notify: c.notify || c.verifiedName || null,
  };
}
