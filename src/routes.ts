// Model routes: send requests for some models to some accounts. Configured per
// provider as `routes.claude` / `routes.codex`, each an ordered list; the first
// route whose pattern matches the request's model applies, and a request with
// no model matches none.
//
// prefer (the default): the route's accounts go first, and when none of them
// can take the request it goes to any other account straight away.
// exclusive: only the route's accounts may serve it, failover included; when
// they are all spent the request gets a 429 rather than leaving the route.
import type { ProviderId } from './types.js';

export type RouteColor = 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan';
export const ROUTE_COLORS: Record<RouteColor, number> = { red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36 };

export interface RouteConfig {
  name: string;
  match: string[] | string;
  // An account's label, id, or 0-based position among this provider's accounts.
  accounts: Array<string | number>;
  mode?: 'prefer' | 'exclusive';
  color?: RouteColor;
}

export interface Route {
  name: string;
  match: string[];
  accounts: Array<string | number>;
  mode: 'prefer' | 'exclusive';
  color: RouteColor | null;
  patterns: RegExp[];
}

// Shell-style: `*` is any run of characters (empty included), everything else
// is literal, case is ignored, and the whole model name must match.
export function globToRegExp(glob: string): RegExp {
  const body = glob.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}$`, 'i');
}

const KEYS = new Set(['name', 'match', 'accounts', 'mode', 'color']);

// Validate a provider's route list. Anything malformed is a startup error, so
// a typo cannot silently turn a route off.
export function parseRoutes(raw: unknown, provider: ProviderId): Route[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error(`routes.${provider} must be a list`);
  const seen = new Set<string>();
  return raw.map((item, index) => {
    const where = `routes.${provider}[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${where} must be an object`);
    const entry = item as Record<string, unknown>;
    for (const key of Object.keys(entry)) if (!KEYS.has(key)) throw new Error(`${where}: unknown key "${key}"`);
    if (typeof entry.name !== 'string' || !entry.name.trim()) throw new Error(`${where}: name is required`);
    const name = entry.name.trim();
    if (seen.has(name)) throw new Error(`routes.${provider}: duplicate route name "${name}"`); seen.add(name);
    const match = typeof entry.match === 'string' ? [entry.match] : entry.match;
    if (!Array.isArray(match) || !match.length || !match.every((m) => typeof m === 'string' && m.length > 0)) throw new Error(`route ${name}: match must be a non-empty list of patterns`);
    const accounts = entry.accounts;
    if (!Array.isArray(accounts) || !accounts.length || !accounts.every((a) => (typeof a === 'string' && a.length > 0) || (Number.isInteger(a) && (a as number) >= 0))) throw new Error(`route ${name}: accounts must be a non-empty list of account labels, ids or 0-based positions`);
    const mode = entry.mode ?? 'prefer';
    if (mode !== 'prefer' && mode !== 'exclusive') throw new Error(`route ${name}: mode must be "prefer" or "exclusive"`);
    const color = entry.color ?? null;
    if (color !== null && !(typeof color === 'string' && color in ROUTE_COLORS)) throw new Error(`route ${name}: color must be one of ${Object.keys(ROUTE_COLORS).join(', ')}`);
    return { name, match: match as string[], accounts: accounts as Array<string | number>, mode, color: color as RouteColor | null, patterns: (match as string[]).map(globToRegExp) };
  });
}

export function matchRoute(routes: Route[], model: string | null | undefined): Route | null {
  if (typeof model !== 'string' || !model) return null;
  return routes.find((route) => route.patterns.some((pattern) => pattern.test(model))) ?? null;
}

export function routeColor(color: RouteColor | null | undefined): number { return color ? ROUTE_COLORS[color] : 36; }
