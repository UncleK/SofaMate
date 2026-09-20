# SofaMate website

The website has separate Home, Discover, About, Download, Sign-in and Privacy pages. Home is a short introduction with an inline video preview; Discover uses the same published catalog as the desktop app. Selecting a work opens Download with its selection preserved. Videos load only after a click, start muted and pause when hidden or scrolled out of view.

Run `npm run build:site` after editing `scripts/site-copy.mjs` or `scripts/build-site.mjs`. It generates six static pages in each of Simplified Chinese, English and Japanese. Chinese URLs are at the root; English uses `/en/`, Japanese `/ja/`. Each has its own title, description, canonical and reciprocal language alternates. The sitemap contains all 15 indexable pages. Sign-in pages are not indexed. `site/app.js` handles language-preserving navigation and dynamic catalog/account controls. Community titles and descriptions remain the author's original text.

The official sample is the existing E12 screen-wiping excerpt, served from persistent public media storage outside Git. It is one video, not a full scene graph. Public desktop downloads remain unchanged and do not bundle website media.

## Promotional artwork

- `site/assets/companions/night-close.png`: real frame from the existing Evening living room E12 video. The woman remains the same character as the released sample.
- `site/assets/companions/day-companion.png`: fictional adult male character artwork created with the built-in image generation tool. The user selected the light-blue-shirt version; the muscular and tank-top variants are not published. This is character artwork, not a released video.
- Final generation prompt: “Photorealistic natural lifestyle portrait, one fictional clearly adult East Asian male university student age 23, normal lean average build, slim ordinary shoulders and slender arms. Friendly boy-next-door face, relaxed warm subtle smile, short slightly tousled black hair. Wearing a loose casual light blue cotton shirt over a plain white tee, sleeves to elbows. Seated casually on a sofa in a bright tasteful modest apartment, comfortable approachable everyday companionship mood. Waist-up, looking at camera, soft natural daylight, realistic skin, candid editorial photography. Landscape 4:3, centered subject, no text, no logo.”

The hero banner pairs the two portraits in an SVG layout; it does not depict the unreleased male character as a downloadable work.
