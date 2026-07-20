import type { AiService } from '../shared/types';

/**
 * The AI quick-access services. Shiori deliberately has no agent features —
 * these are ordinary web sessions to the official chat sites, docked into a
 * side panel so they are one click away while reading.
 */
export const AI_SERVICES: Record<AiService, { label: string; url: string }> = {
  chatgpt: { label: 'ChatGPT', url: 'https://chatgpt.com/' },
  gemini: { label: 'Gemini', url: 'https://gemini.google.com/' },
  claude: { label: 'Claude', url: 'https://claude.ai/' },
  perplexity: { label: 'Perplexity', url: 'https://www.perplexity.ai/' },
};

export function isAiService(value: unknown): value is AiService {
  // hasOwnProperty, not `in`: `'toString' in AI_SERVICES` is true via the
  // prototype chain, which would let a bogus service name through validation.
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(AI_SERVICES, value);
}

/** The default tile line-up for the parallel AI grid (all four services). */
export const AI_SERVICE_ORDER: AiService[] = ['chatgpt', 'gemini', 'claude', 'perplexity'];

/**
 * Where each chat site keeps its message composer and send button. The parallel
 * grid's broadcast bar focuses the composer and types the user's text into it
 * (via webContents.insertText) — this is not automation of the AI, just the
 * same keystrokes the user would make, fanned out to every tile at once.
 *
 * Selectors are ordered most- to least-specific and are pure best-effort: sites
 * change their DOM, so the injector falls back to "the last visible textarea or
 * contenteditable" and, failing even that, simply focuses the tile. It never
 * throws and never reads the reply — there is no agent here.
 */
export const AI_COMPOSERS: Record<AiService, { composer: string[]; submit: string[] }> = {
  chatgpt: {
    composer: ['#prompt-textarea', 'div[contenteditable="true"]', 'textarea'],
    submit: ['button[data-testid="send-button"]', 'button[aria-label*="Send" i]'],
  },
  gemini: {
    composer: ['.ql-editor[contenteditable="true"]', 'div[contenteditable="true"]', 'textarea'],
    submit: ['button.send-button', 'button[aria-label*="Send" i]', 'button[mattooltip*="Send" i]'],
  },
  claude: {
    composer: ['div.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"]', 'textarea'],
    submit: ['button[aria-label*="Send" i]', 'button[type="submit"]'],
  },
  perplexity: {
    composer: ['textarea[placeholder]', 'div[contenteditable="true"]', 'textarea'],
    submit: ['button[aria-label*="Submit" i]', 'button[aria-label*="Send" i]'],
  },
};

/**
 * "Continue with Google/Apple/Microsoft", "Sign in with SSO", AWS IAM Identity
 * Center, etc. all open a real OAuth/SAML popup window and hand the result back
 * to their opener (window.opener.postMessage or the popup simply closing).
 * Denying those — or turning them into a standalone reading page, which severs
 * window.opener — breaks sign-in entirely. So any window.open that is clearly a
 * login flow must stay a real child window with a live opener. Everything else
 * (a link a page or chat answer opened in a new window) belongs in a page.
 *
 * We recognize a login window two ways: by identity-provider host, and by the
 * shape of the URL (an OAuth2/OIDC/SAML authorize endpoint). The URL heuristic
 * is what generalizes this to arbitrary sites we never hard-coded.
 */
const AUTH_HOSTS = [
  // Google
  /(^|\.)accounts\.google\.com$/i,
  // Apple
  /(^|\.)appleid\.apple\.com$/i,
  /(^|\.)idmsa\.apple\.com$/i,
  // Microsoft / Entra ID / Azure AD B2C
  /(^|\.)login\.microsoftonline\.com$/i,
  /(^|\.)login\.microsoft\.com$/i,
  /(^|\.)login\.live\.com$/i,
  /(^|\.)login\.windows\.net$/i,
  /(^|\.)b2clogin\.com$/i,
  // Amazon Web Services (root/IAM sign-in, IAM Identity Center, Cognito)
  /(^|\.)signin\.aws\.amazon\.com$/i,
  /(^|\.)signin\.amazon\.com$/i,
  /(^|\.)awsapps\.com$/i,
  /(^|\.)amazoncognito\.com$/i,
  // GitHub / GitLab (OAuth authorize + device/login)
  /(^|\.)github\.com$/i,
  /(^|\.)gitlab\.com$/i,
  // OpenAI
  /(^|\.)auth\.openai\.com$/i,
  // Common identity providers / SSO / MFA
  /(^|\.)auth0\.com$/i,
  /(^|\.)okta\.com$/i,
  /(^|\.)oktapreview\.com$/i,
  /(^|\.)okta-emea\.com$/i,
  /(^|\.)onelogin\.com$/i,
  /(^|\.)pingidentity\.com$/i,
  /(^|\.)duosecurity\.com$/i,
];

export function isAuthPopupUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (AUTH_HOSTS.some((re) => re.test(u.hostname))) return true;

  // Generic OAuth2 / OIDC / SAML authorization endpoints, so "sign in with X"
  // on a site we never listed is still treated as a login window, not a page.
  const path = u.pathname.toLowerCase();
  const q = u.searchParams;
  if (/\/(oauth2?|oidc)\/(auth|authorize)\b/.test(path)) return true;
  if (/\/(saml2?|sso|signin|login|authorize)\b/.test(path) && q.has('SAMLRequest')) return true;
  if (
    q.has('client_id') &&
    (q.has('redirect_uri') || q.has('response_type') || (q.get('scope') ?? '').includes('openid'))
  ) {
    return true;
  }
  return false;
}
