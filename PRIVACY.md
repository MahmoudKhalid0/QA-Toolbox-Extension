# Privacy Policy — QA Testing Toolkit

**Last updated:** 9 July 2026

QA Testing Toolkit is a browser extension that helps QA engineers test websites. This policy explains exactly what data the extension handles, what leaves your device, and what does not.

There is **no QA Testing Toolkit server**. We do not operate a backend, we do not run analytics, and we do not have a database of users. Nothing is collected about you, sold, or shared with advertisers.

---

## Data stored on your device

The extension stores the following locally, using the browser's own extension storage:

- **Test profiles** you create (names, emails, phone numbers, addresses and any other field values you enter for form filling)
- **Extension settings and preferences**
- **Profile categories**

This data stays in your browser unless you turn on Cloud Sync (below). Uninstalling the extension removes it.

---

## Data that leaves your device

There are exactly two destinations, and both are opt-in by your actions.

### 1. Anthropic (Claude AI) — only when you use an AI feature

Some tools call the Claude API at `api.anthropic.com`. This only happens when you explicitly trigger one of them. What gets sent depends on the tool:

| Feature | What is sent |
|---|---|
| Translate | The text you selected |
| Review language | The text you selected |
| Extract text from image (OCR) | The image you selected |
| Generate test profile | The form field labels/names on the page |
| Generate XPath | The element and its ancestor markup |
| Explain console error | The error message and stack trace |
| Explain network request | The request/response metadata |
| Explain performance | The page's performance timings |

Anthropic processes this to return a result. Anthropic does not use API inputs to train its models. See Anthropic's privacy policy: https://www.anthropic.com/legal/privacy

**If you never use an AI feature, nothing is ever sent to Anthropic.**

### 2. Google Drive — only if you enable Cloud Sync

If you sign in under Cloud Sync, the extension stores a backup of your profiles, settings and categories in **your own Google Drive**, in the hidden `appDataFolder` space. This is a private, app-only area of your Drive:

- Only this extension can read or write it. Other apps cannot.
- The developer cannot see it. It is in your Google account, not ours.
- Signing out and revoking access stops all syncing.

To do this, the extension requests two permissions from your Google account:

- `drive.appdata` — to read and write **only its own** backup file. It cannot see any of your other Drive files.
- `email` — to display which account you are signed in as.

Authentication uses Google's standard OAuth flow (`accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`). The access token is stored on your device and is revoked when you sign out.

**If you never sign in, nothing is ever sent to Google.**

---

## What the extension can access, and why

The extension requests broad browser permissions because QA tools have to operate on whatever page you are testing. It reads page content only while you actively use a tool.

| Permission | Why it is needed |
|---|---|
| Access to all sites (`<all_urls>`) | The tools must work on whatever site you are testing — we cannot know it in advance |
| `scripting` | Injects the tool panels (inspector, measure, responsive view, etc.) into the page you are testing |
| `cookies` | The Cookies & Storage tool lets you view and edit the current site's cookies |
| `browsingData` | The Clear Data tool clears cache/cookies on demand |
| `declarativeNetRequest` | The Responsive Viewer spoofs the User-Agent so the site serves its mobile layout |
| `tabs`, `webNavigation` | Knows which tab you are testing and when it navigates |
| `storage` | Saves your profiles and settings |
| `identity` | Google sign-in for Cloud Sync (only used if you enable it) |
| `sidePanel` | The extension's UI lives in the browser side panel |

The **API Data Export** tool replays a request you paste in and saves the result as a CSV file on your computer. That data is never uploaded anywhere.

Page content read by a tool is used to produce the result you asked for and is not retained after the tool closes, except where you explicitly send it to an AI feature as described above.

---

## Children

This extension is a developer tool and is not directed at children under 13.

## Changes

If this policy changes, the "Last updated" date above changes with it, and the new version is published at this same URL.

## Contact

Mahmoud Khalid — mahmoud.khalid.sh1@gmail.com
