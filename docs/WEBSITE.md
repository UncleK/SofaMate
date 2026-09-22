# SofaMate website

The website has separate Home, Discover, About, Download, Sign-in and Privacy pages. Home is a short introduction with an inline video preview; Discover uses the same published catalog as the desktop app. Selecting a work opens Download with its selection preserved. Videos load only after a click, start muted and pause when hidden or scrolled out of view.

Run `npm run build:site` after editing `scripts/site-copy.mjs` or `scripts/build-site.mjs`. It generates six static pages in each of Simplified Chinese, English and Japanese. Chinese URLs are at the root; English uses `/en/`, Japanese `/ja/`. Each has its own title, description, canonical and reciprocal language alternates. The sitemap contains all 15 indexable pages. Sign-in pages are not indexed. `site/app.js` handles language-preserving navigation and dynamic catalog/account controls. Community titles and descriptions remain the author's original text.

The official preview is the existing E12 screen-wiping excerpt, served from persistent public media storage outside Git. It is one video, not a full scene graph. Its call to action uses `download?theme=living-room-night` and explains how to download the complete theme in the client. Legacy `?scene=night` links use the same complete-theme path. Community selections retain their own MP4 download and filename. Public client downloads do not bundle videos.

## Current capabilities and account display

Keep the three-language copy, visible FAQs, FAQ structured data, READMEs and release notes consistent. The client supports independent wallpapers per monitor, fit/fill without stretching, and explicit application after selecting a downloaded quality. Public official packs are 720P24, 1080P24 and 1080P60; 4K remains local-only. The Windows ZIP is approximately 1.95 MiB as of September 22, 2026. Imported single videos loop normally; the official living-room pack follows its declared random successor graph.

Every page obtains the SofaMate session from `/v1/auth/me` with same-origin credentials and `no-store`. The navigation shows the verified display name as plain text and links to the localized account page. Focus, returning to a visible tab, back-forward cache restoration and a cross-tab session-change signal refresh that state. A generation counter prevents an old response from restoring a logged-out identity. Local storage carries only the language and an opaque change signal, never names, email addresses or tokens. No background polling is needed.

Sign-in and registration share the Aveniqa entry. The identity provider's email-code flow allows first-time account creation; Google/GitHub use the same return path to SofaMate consent. The website explains this before leaving. Being signed into Aveniqa alone does not create a SofaMate session until the connection is authorized. Read-only `/me` and `/config` use the ordinary API rate limit, while sign-in and verification keep the stricter auth quota.

The build assigns a content revision to JS/CSS URLs so updated pages load matching assets. Verify a change with `npm run build:site`, then `node scripts/prepare-site-browser-check.mjs` and `playwright-cli run-code --filename output/playwright/site-account-check.js` in a dedicated browser session. This uses intercepted fixture responses, never production account creation or logout. Also verify the deployed anonymous pages and real registration entry. Fixture session checks do not prove a person's completed OAuth consent or desktop pairing.

## Promotional artwork

- `site/assets/companions/night-close.png`: real frame from the existing Evening living room E12 video. The woman remains the same character as the released sample.
- `site/assets/companions/day-companion.png`: fictional adult male character artwork created with the built-in image generation tool. The user selected the light-blue-shirt version; the muscular and tank-top variants are not published. This is character artwork, not a released video.
- Final generation prompt: “Photorealistic natural lifestyle portrait, one fictional clearly adult East Asian male university student age 23, normal lean average build, slim ordinary shoulders and slender arms. Friendly boy-next-door face, relaxed warm subtle smile, short slightly tousled black hair. Wearing a loose casual light blue cotton shirt over a plain white tee, sleeves to elbows. Seated casually on a sofa in a bright tasteful modest apartment, comfortable approachable everyday companionship mood. Waist-up, looking at camera, soft natural daylight, realistic skin, candid editorial photography. Landscape 4:3, centered subject, no text, no logo.”

The hero banner pairs the two portraits in an SVG layout; it does not depict the unreleased male character as a downloadable work.
