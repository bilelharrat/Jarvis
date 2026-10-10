# Eden for Education in Canvas, Moodle and Blackboard (LTI 1.3): registering a school

Eden for Education is an LTI 1.3 tool (code: `site/src/edu/lti.js`, `site/src/edu/lti-store.js`; tests:
`site/test/lti.test.js`). Each school's platform has to be registered on both sides: the school adds Eden
to its LMS, and you (the owner) add the school's platform to askeden.com. Nothing here is self-serve.

Not built: grades going back to the LMS (Assignment and Grade Services), and the LTI Platform Storage
postMessage flow. In an iframe Eden shows "Open Eden in a new tab", so set placements to open in a new
window/tab where the platform allows it.

## 1. Once: the tool key and the admin token (Worker secrets)

From `JARVIS V1/site`, with the same wrangler config you deploy with:

```sh
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out lti-key.pem
npx wrangler secret put LTI_PRIVATE_KEY < lti-key.pem      # the tool's signing key (PKCS#8 PEM)
openssl rand -base64 36 | tr -d '\n' | npx wrangler secret put LTI_ADMIN_TOKEN   # 24+ characters; keep a copy in your password manager
rm lti-key.pem                                              # or keep it offline; the Worker is the only place it's needed
```

Repeat with `--config wrangler.nor2.toml` (or the preview config) if you deploy with that one. Without
`LTI_PRIVATE_KEY`, `/lti/jwks` answers 503 and deep linking and Names and Roles can't work; without
`LTI_ADMIN_TOKEN` (or one shorter than 24 characters), `/api/admin/lti` stays closed.

Changing the key: put a new `LTI_PRIVATE_KEY`. The key id (`kid`) is the key's RFC 7638 thumbprint, so it
changes with it; platforms that read the JWKS URL pick it up. Only one key is published at a time.

## 2. The addresses a school's admin needs

| What the LMS asks for | Value |
|---|---|
| OIDC login / initiation URL | `https://askeden.com/lti/login` |
| Redirect URI(s), target link URI, launch URL | `https://askeden.com/lti/launch` |
| Deep linking / content selection URL | `https://askeden.com/lti/launch` |
| Public key: JWKS / keyset URL | `https://askeden.com/lti/jwks` |
| Services | Names and Role Provisioning (read the class list) |
| Privacy | Send the user's name (it labels students in the class list; optional) |

`GET https://askeden.com/api/admin/lti` (with your token) also lists these.

### Canvas (Admin › Developer Keys › + Developer Key › LTI Key)

- Method "Manual entry": Redirect URIs and Target Link URI `…/lti/launch`, OpenID Connect Initiation URL
  `…/lti/login`, JWK Method "Public JWK URL" `…/lti/jwks`.
- LTI Advantage Services: turn on "Can retrieve user data associated with the context the tool is installed in".
- Placements: Course Navigation (and, if wanted, Link Selection or Assignment Selection with message type
  LtiDeepLinkingRequest). For Course Navigation add `"windowTarget": "_blank"` if your Canvas offers it.
- Privacy level: Public (names) or Anonymous (no names).
- Save, turn the key ON, copy its Client ID (a number like `10000000000042`). Then Settings › Apps ›
  + App › By Client ID in the account or sub-account; the app's Deployment ID shows under its settings.
- For you (step 3), Canvas Cloud uses: issuer `https://canvas.instructure.com`, auth_url
  `https://sso.canvaslms.com/api/lti/authorize_redirect`, token_url `https://sso.canvaslms.com/login/oauth2/token`,
  jwks_url `https://sso.canvaslms.com/api/lti/security/jwks` (beta/test Canvas: `canvas.beta.instructure.com` /
  `sso.beta.canvaslms.com`, `canvas.test.instructure.com` / `sso.test.canvaslms.com`; self-hosted Canvas: its own host).

### Moodle (Site administration › Plugins › Activity modules › External tool › Manage tools › configure a tool manually)

- LTI version 1.3; Tool URL `…/lti/launch`; Public key type "Keyset URL" `…/lti/jwks`; Initiate login URL
  `…/lti/login`; Redirection URI(s) `…/lti/launch`; "Supports Deep Linking" on, Content Selection URL `…/lti/launch`.
- Default launch container: New window. Services: IMS LTI Names and Role Provisioning "Use this service".
  Privacy: share the launcher's name with the tool, as the school prefers.
- After saving, "View configuration details" shows the Client ID, Deployment ID and the platform's URLs:
  issuer = the Moodle site URL, auth_url `<site>/mod/lti/auth.php`, token_url `<site>/mod/lti/token.php`,
  jwks_url `<site>/mod/lti/certs.php`.

### Blackboard Learn

- You register Eden once at developer.anthology.com (Blackboard developer portal) as an LTI 1.3 tool with the
  addresses above; it gives you an Application ID (the client id). Each school's admin then adds it under
  Administrator Panel › Integrations › LTI Tool Providers › Register LTI 1.3/Advantage Tool with that id and
  gets a Deployment ID. Set the placements' "Launch in new window".
- Platform values: issuer `https://blackboard.com`, auth_url `https://developer.blackboard.com/api/v1/gateway/oidcauth`,
  token_url `https://developer.blackboard.com/api/v1/gateway/oauth2/jwttoken`, jwks_url
  `https://developer.blackboard.com/api/v1/management/applications/<application id>/jwks.json`.

## 3. Adding the school on askeden.com

```sh
curl -sS -X POST https://askeden.com/api/admin/lti \
  -H "Authorization: Bearer $LTI_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"action":"put","name":"State U Canvas","issuer":"https://canvas.instructure.com","client_id":"10000000000042",
       "deployments":["7:abc123…"],"auth_url":"https://sso.canvaslms.com/api/lti/authorize_redirect",
       "token_url":"https://sso.canvaslms.com/login/oauth2/token","jwks_url":"https://sso.canvaslms.com/api/lti/security/jwks"}'
```

- `name` is what professors and students see ("Opened from State U Canvas").
- `deployments`: every deployment id the school uses (a sub-account install is another deployment). To add one,
  send the same body with the registration's `id` (from the answer, or `GET /api/admin/lti`) and the longer list.
- `token_aud` (optional): the audience the platform wants in Eden's token request, when it isn't the token URL.
- Removing a school: `-d '{"action":"delete","id":"<id>"}'`. Its launches stop at once; course links and
  people's connections stay stored but are unused.
- Only https addresses are accepted, and one registration per issuer + client id.

## 4. What professors and students see

1. A professor opens Eden from their LMS course, signs in to Eden if needed, and picks one of their Eden
   courses to connect (or, from a deep-linking placement, picks it there and returns to the LMS). Only the
   Eden course's owner can connect it.
2. A student opening Eden from that LMS course signs in to Eden, confirms they're 13 or older, and joins the
   Eden course (their LMS name as their class-list name). LMS TAs and other instructors join as TAs.
3. Coming back, the professor can "Sync the class list": students and TAs who have opened Eden from the LMS
   get their roles; nobody is removed automatically; people who never opened Eden aren't added.

Each LMS account connects to one Eden account (the first one used). If a student signed in with a
different Eden account, they're told to switch back.

## 5. Security notes (for the independent review)

The launch checks are listed at the top of `site/src/edu/lti.js`. In short: registered issuer, client id and
deployment only; state is one-time, server-side, 10 minutes, and must match a `__Host-` cookie; the nonce is
bound to it; id_tokens are RS256 only, verified with the platform's registered JWKS by `kid`, with iss, aud/azp,
exp/iat/nbf, version, message type and target checked; after the launch a 15-minute ticket lives server-side
under its SHA-256 and in a `SameSite=Lax` cookie (never in a URL); every action is a same-origin POST with the
ticket's CSRF value and the Eden session. Roles come only from the signed token's context membership roles.
Logins are rate-limited per network (API_RATE, 120 a minute).
