/**
 * Category catalog.
 *
 * A category is a curated bundle of well-known targets. Adding a category to
 * the rule set expands into all of its known members, so a user can block
 * "Social Media" or "Gaming" in one tap. The catalog is intentionally small
 * and conservative here; in production it would be a versioned, signed list
 * shipped with (and updatable independently of) the app.
 */

import type { Target } from './types.js';

export const CATEGORY_IDS = [
  'social-media',
  'gaming',
  'shopping',
  'streaming',
  'news',
  'ai',
  'adult',
  'messaging',
] as const;

export type CategoryId = (typeof CATEGORY_IDS)[number];

export interface Category {
  id: CategoryId;
  label: string;
  /** Bare domains, matched including subdomains. */
  domains: string[];
  /** Application / process names. */
  apps: string[];
}

export const CATEGORIES: Record<CategoryId, Category> = {
  'social-media': {
    id: 'social-media',
    label: 'Social Media',
    domains: ['facebook.com', 'instagram.com', 'tiktok.com', 'twitter.com', 'x.com', 'reddit.com', 'snapchat.com', 'threads.net', 'linkedin.com'],
    apps: ['Instagram', 'TikTok'],
  },
  gaming: {
    id: 'gaming',
    label: 'Gaming',
    domains: ['store.steampowered.com', 'epicgames.com', 'roblox.com', 'twitch.tv', 'leagueoflegends.com'],
    apps: ['Steam', 'League of Legends', 'Epic Games Launcher', 'Roblox'],
  },
  shopping: {
    id: 'shopping',
    label: 'Shopping',
    domains: ['amazon.com', 'ebay.com', 'etsy.com', 'aliexpress.com', 'walmart.com'],
    apps: [],
  },
  streaming: {
    id: 'streaming',
    label: 'Streaming',
    domains: ['youtube.com', 'netflix.com', 'hulu.com', 'disneyplus.com', 'twitch.tv', 'primevideo.com'],
    apps: [],
  },
  news: {
    id: 'news',
    label: 'News',
    domains: ['cnn.com', 'bbc.com', 'nytimes.com', 'foxnews.com', 'theguardian.com'],
    apps: [],
  },
  ai: {
    id: 'ai',
    label: 'AI',
    domains: ['chatgpt.com', 'openai.com', 'gemini.google.com', 'perplexity.ai', 'character.ai'],
    apps: [],
  },
  adult: {
    id: 'adult',
    label: 'Adult',
    domains: [],
    apps: [],
  },
  messaging: {
    id: 'messaging',
    label: 'Messaging',
    domains: ['discord.com', 'web.whatsapp.com', 'telegram.org', 'messenger.com', 'slack.com'],
    apps: ['Discord', 'Slack', 'Telegram', 'WhatsApp'],
  },
};

export function isCategoryId(value: string): value is CategoryId {
  return (CATEGORY_IDS as readonly string[]).includes(value);
}

let seq = 0;
function memberId(categoryId: string, value: string): string {
  seq += 1;
  return `cat:${categoryId}:${value}:${seq}`;
}

/**
 * Expand a category into concrete member targets. The engine treats these
 * exactly like any user-added target. `idFactory` lets callers supply stable
 * ids (e.g. deterministic hashes) instead of the sequential default.
 */
export function expandCategory(
  categoryId: CategoryId,
  idFactory: (value: string) => string = (value) => memberId(categoryId, value),
): Target[] {
  const category = CATEGORIES[categoryId];
  const domains: Target[] = category.domains.map((domain) => ({
    id: idFactory(domain),
    kind: 'domain',
    value: domain,
    label: domain,
  }));
  const apps: Target[] = category.apps.map((app) => ({
    id: idFactory(app),
    kind: 'app',
    value: app,
    label: app,
  }));
  return [...domains, ...apps];
}
