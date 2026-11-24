import { graph, type Paged } from '@/lib/graph';
import { getConnectedPages } from './pages';

export type Platform = 'all' | 'facebook' | 'instagram';
export type ContentType = 'all' | 'post' | 'reel';

export type ContentItem = {
  id: string;
  platform: 'facebook' | 'instagram';
  type: 'post' | 'reel' | 'video' | 'carousel' | 'image';
  pageId: string;
  pageName?: string;
  account?: string;
  caption?: string;
  mediaUrl?: string;
  thumbnailUrl?: string;
  permalink?: string;
  createdAt: string;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  reach?: number;
  durationSec?: number;
};

// Cursor per source ("<pageId>:<source>"). null = source exhausted.
type Cursor = Record<string, string | null>;

const FB_POST_FIELDS =
  'id,message,created_time,full_picture,permalink_url,status_type,shares,' +
  'reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)';
const FB_REEL_FIELDS = 'id,description,created_time,permalink_url,picture,length';
const IG_FIELDS =
  'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count';

function absolute(url?: string) {
  if (!url) return url;
  return url.startsWith('/') ? `https://www.facebook.com${url}` : url;
}

export function decodeCursor(raw: string | null): Cursor {
  if (!raw) return {};
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function encodeCursor(c: Cursor) {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

async function igInsights(mediaId: string, token: string) {
  try {
    const r = await graph<{ data: { name: string; values?: { value: number }[]; total_value?: { value: number } }[] }>(
      `${mediaId}/insights`,
      { token, params: { metric: 'reach,shares,saved' } },
    );
    const get = (n: string) => {
      const m = r.data.find((d) => d.name === n);
      return m?.total_value?.value ?? m?.values?.[0]?.value;
    };
    return { reach: get('reach'), shares: get('shares'), saves: get('saved') };
  } catch {
    return {}; // insights are unavailable for some media (e.g. very old, or account lacks permission)
  }
}

export async function getContent(opts: {
  pageId?: string | null;
  platform: Platform;
  type: ContentType;
  limit: number;
  cursor: Cursor;
  insights: boolean;
}) {
  const pages = await getConnectedPages(opts.pageId);
  const next: Cursor = { ...opts.cursor };
  const items: ContentItem[] = [];
  const errors: { pageId: string; source: string; error: string }[] = [];

  const jobs: Promise<void>[] = [];
  for (const { page, token } of pages) {
    const run = (source: string, fn: (after?: string) => Promise<{ items: ContentItem[]; after?: string }>) => {
      const key = `${page.pageId}:${source}`;
      if (next[key] === null) return; // exhausted
      jobs.push(
        fn(next[key] ?? undefined)
          .then((r) => {
            items.push(...r.items);
            next[key] = r.after ?? null;
          })
          .catch((e) => {
            errors.push({ pageId: page.pageId, source, error: e.message });
            next[key] = null;
          }),
      );
    };

    const wantFb = opts.platform !== 'instagram';
    const wantIg = opts.platform !== 'facebook' && page.instagram?.id;

    if (wantFb && opts.type !== 'reel') {
      run('fb_posts', async (after) => {
        const r = await graph<Paged<any>>(`${page.pageId}/posts`, {
          token,
          params: { fields: FB_POST_FIELDS, limit: opts.limit, after },
        });
        return {
          after: r.paging?.next ? r.paging.cursors?.after : undefined,
          items: r.data.map((p) => ({
            id: p.id,
            platform: 'facebook',
            type: 'post',
            pageId: page.pageId,
            pageName: page.name ?? undefined,
            caption: p.message,
            mediaUrl: p.full_picture,
            thumbnailUrl: p.full_picture,
            permalink: p.permalink_url,
            createdAt: p.created_time,
            likes: p.reactions?.summary?.total_count,
            comments: p.comments?.summary?.total_count,
            shares: p.shares?.count ?? 0,
          })),
        };
      });
    }

    if (wantFb && opts.type !== 'post') {
      run('fb_reels', async (after) => {
        const r = await graph<Paged<any>>(`${page.pageId}/video_reels`, {
          token,
          params: { fields: FB_REEL_FIELDS, limit: opts.limit, after },
        });
        return {
          after: r.paging?.next ? r.paging.cursors?.after : undefined,
          items: r.data.map((v) => ({
            id: v.id,
            platform: 'facebook',
            type: 'reel',
            pageId: page.pageId,
            pageName: page.name ?? undefined,
            caption: v.description,
            thumbnailUrl: v.picture,
            permalink: absolute(v.permalink_url),
            createdAt: v.created_time,
            durationSec: v.length,
          })),
        };
      });
    }

    if (wantIg) {
      const igId = page.instagram!.id!;
      run('ig_media', async (after) => {
        const r = await graph<Paged<any>>(`${igId}/media`, {
          token,
          params: { fields: IG_FIELDS, limit: opts.limit, after },
        });
        const mapped: ContentItem[] = r.data
          .map((m): ContentItem => {
            const isReel = m.media_product_type === 'REELS';
            return {
              id: m.id,
              platform: 'instagram',
              type: isReel ? 'reel' : m.media_type === 'CAROUSEL_ALBUM' ? 'carousel' : m.media_type === 'VIDEO' ? 'video' : 'post',
              pageId: page.pageId,
              pageName: page.name ?? undefined,
              account: page.instagram?.username ?? undefined,
              caption: m.caption,
              mediaUrl: m.media_url,
              thumbnailUrl: m.thumbnail_url ?? m.media_url,
              permalink: m.permalink,
              createdAt: m.timestamp,
              likes: m.like_count,
              comments: m.comments_count,
            };
          })
          .filter((m) => opts.type === 'all' || (opts.type === 'reel' ? m.type === 'reel' : m.type !== 'reel'));

        if (opts.insights) {
          const stats = await Promise.all(mapped.map((m) => igInsights(m.id, token)));
          mapped.forEach((m, i) => Object.assign(m, stats[i]));
        }
        return { after: r.paging?.next ? r.paging.cursors?.after : undefined, items: mapped };
      });
    }
  }

  await Promise.all(jobs);
  items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const hasMore = Object.values(next).some((v) => v !== null);
  return { items, errors, next: hasMore ? encodeCursor(next) : null };
}
