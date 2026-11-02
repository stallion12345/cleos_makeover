# Cleo's Makeover

**Scan your skin, meet your queen profile, get a short routine tied to your real scores, and rescan to see if anything changed. Honest about what a selfie can show.**

Built for the YouCam API Skin AI & eCommerce VTO Hackathon. Designed for English-literate women in Northern Nigerian cities, on phones.

> Skincare guidance, not medical advice. A selfie scan shows what the camera sees, not why.

- Demo video: `<ADD YOUTUBE LINK>`
- Live demo: `<ADD LIVE URL>` (rate-limited per visitor to protect API units; if you hit the limit, watch the video or run it locally below)
- Code: this repository

---

## What it does

1. **Guided capture.** The YouCam Camera Kit checks face size, angle and lighting live and only captures a good frame. A basic camera and a photo upload are available as fallbacks. A "Scan this photo?" step protects your API units.
2. **Skin scan.** The photo goes to YouCam AI Skin Analysis, which returns scores for 13 concerns plus skin type by zone (whole face, T-zone, U-zone).
3. **Queen profile.** Five profiles (Amina of Zazzau, Nefertiti, Hatshepsut, Nzinga, Amanirenas) are matched from the user's lowest-scoring concerns. Cleo (Cleopatra VII, a Ptolemaic queen of Egypt) is the guide. Each profile is *inspired by* the figure, not a claim about her skin.
4. **Results.** Scores ranked from the lowest, plus tap-to-show overlays that mark where a concern appears on the user's own face.
5. **Routine.** Morning and evening, at most four generic products, each tied to a specific score. It also says "you don't need a product for this" where the score is already good.
6. **Try a look.** A preview of a ready-made makeup look on the user's own photo, using YouCam AI Look Virtual Try-On, from curated categories.
7. **Skin passport.** A local record: a passport-style Skin ID card (a default silhouette that the user's own photo can replace, only if they choose; downloadable as an image), routine consistency, a product log with check-ins, a skin journey, a downloadable summary and a delete-everything button.

## How it uses the YouCam APIs

| Feature | YouCam API | Where |
|---|---|---|
| Skin analysis (SD): wrinkle, firmness, acne, moisture, eye bag, dark circle, age spot, radiance, redness, oiliness, pore, texture, tear trough, eyelids, skin type | **AI Skin Analysis** (`task/skin-analysis`) | `server.js` `/api/scan` |
| Image upload | **File API** (`/s2s/v2.0/file`) | `server.js` |
| Makeup look preview | **AI Look Virtual Try-On** (`task/look-vto`, plus the template list) | `server.js` `/api/looks`, `/api/vto` |
| Quality-gated capture | **JS Camera Kit** (`skincare` mode) | `public/index.html` |

## Architecture

```
Browser (public/index.html)  -->  Express proxy (server.js)  -->  YouCam API
  camera, UI, persona logic        keeps the API key secret        skin analysis, looks
  saves scores on the device       no photo is written to disk
```

The API key never reaches the browser. The server holds it, uploads the photo, starts the task and polls for the result.

## Quick start

**You need:** Node.js 18 or newer, and a YouCam API key from <https://yce.perfectcorp.com/ai-api> with units available.

```bash
git clone <THIS REPO URL>
cd <REPO FOLDER>
npm install
cp .env.example .env        # Windows: copy .env.example .env
# open .env and paste your key after YOUCAM_API_KEY=
npm start
```

Open <http://localhost:3000>. On startup you should see:

```
Loaded settings from .env
Key loaded: ... characters, ends with "...."
Page found: ...
Cleo's Makeover running at http://localhost:3000
```

To test your key without spending scan units, open <http://localhost:3000/api/ping>. It should return `"ok":true`.

The camera works on `localhost`. On a phone it needs HTTPS (use a tunnel or deploy it).

### Settings (`.env`)

| Name | Meaning | Default |
|---|---|---|
| `YOUCAM_API_KEY` | Your YouCam API key | required |
| `MAX_SCANS` | Scans allowed per server run (protects your units) | 40 |
| `MAX_VTO` | Look try-ons allowed per server run | 15 |
| `PER_IP_SCANS` | Scans allowed per visitor per 24 hours (for a public demo) | 6 |
| `PER_IP_VTO` | Look try-ons allowed per visitor per 24 hours | 12 |
| `PUBLIC_DEMO` | Set to `1` on a public host to hide the key-test page | unset |
| `PORT` | Port to listen on (hosting platforms set this) | 3000 |

Costs, from the YouCam documentation: a skin scan with all concerns is about 16 units, and a look try-on is 2 units. Check the unit calculator in your console.

### Hosting it yourself

Any Node host works (build: `npm install`, start: `npm start`). Set `YOUCAM_API_KEY` as an environment variable on the host, never in the repo, and set `PUBLIC_DEMO=1`. Hosts provide HTTPS, which the Camera Kit needs on phones. Because a public link spends your YouCam units, keep `MAX_SCANS`, `MAX_VTO` and the per-visitor limits low.

## Using the app

1. Home, then **Start my scan**. Read the short notice, then **Take photo** (Camera Kit), **Use basic camera**, or **Upload photo**.
2. Check the photo on the review screen and confirm.
3. Read your profile and scores on **Results**. Tap a concern to see its overlay. Tap **Save results for tracking**.
4. Open **Routine** for morning and evening steps, and **Try a look** to preview a makeup look.
5. Open **Passport** for your Skin ID card, routine ticks, product log and check-ins.

**Demo mode:** add `?demo=1` to the address (for example `http://localhost:3000/?demo=1`). On the Passport screen a button shifts the date of your first saved scan back four weeks so a check-in can be shown without waiting. It only changes a date, uses your real saved scores, and labels the result "(demo: date shifted)".

## Design decisions: honesty and privacy

- **Raw scores only.** The YouCam docs say `ui_score` is adjusted to give more favourable results. This app ranks and compares with `raw_score`.
- **A change must be big enough.** A difference under 12 points between two scans is shown as "No clear change". Selfies vary with light and angle. 12 is a starting threshold, not a validated one.
- **No causal claims.** Check-in wording says a score changed since a product was started, never that the product caused it. A "something else changed" box makes the comparison "not fair". Low routine consistency does the same.
- **Photos are not stored by this app unless the user chooses.** The photo exists in the browser and in memory on the server while a request runs, and the server never writes it to disk. Saved data is scores, product names, ticks and preferences in the browser's local storage. If the user taps *Use as my Skin ID photo*, a small thumbnail (240 x 300) is kept in local storage on that device only. It can be removed at any time, and there is a delete-everything button. YouCam's own retention applies to what it processes (its docs state results are kept for 24 hours).
- **No medical claims.** The app tells users to ask a pharmacist or doctor when something looks wrong, and asks users with a prescribed skin treatment to read results as a snapshot.
- **No brands.** Routine steps are generic product types. "Find to buy" opens a store search for the product type only. This app does not sell products or earn commission.
- **History with care.** Captions are short and hedged. Amina's dates and title are debated by historians, so none are shown. Artwork is abstract because no portraits of these women exist.
- **Looks are curated.** The YouCam looks library contains many costume, national-flag and celebrity-themed looks. The app shows only chosen categories and hides looks named after real people or characters. The Celebrity category, if shown, carries a disclaimer.

## Limitations

- Selfie scores move with lighting, angle and camera. In the author's own tests, the same face scored differently across photos taken in different conditions. This is not a clinical measurement.
- Only the author's own photos have been used so far. No claim is made about accuracy across skin tones.
- The Camera Kit needs HTTPS on phones. The basic camera and upload work as fallbacks.
- Look previews come from YouCam's library and are not product matches. Colours on screen can differ from real products.
- "Find to buy" uses a Jumia Nigeria search address. If it stops working, change the `SHOP` line in `public/index.html`.

## Project structure

```
server.js          Express proxy: /api/scan, /api/looks, /api/vto, /api/ping
public/index.html  The whole front end (HTML, CSS, JS; emblems embedded)
.env.example       Settings template (copy to .env)
README.md
```

## Credits

- **YouCam API and Camera Kit** by Perfect Corp.
- Persona emblem artwork: designed with Lovable, enlarged four times with an open EDSR super-resolution model and given clean edges.
- Headings use Playfair Display (Google Fonts, SIL Open Font Licence).
- Historical context: summaries written for this project. Amina of Zazzau is a figure whose dates and title are debated (sources include the Kano Chronicle and Muhammad Bello's *Infaq al-Maisuri*).

## Roadmap

This project is a first step toward an honest skincare platform: barcode ingredient checks, sharing a skin summary with a pharmacist or dermatologist (with the user's consent), and partner stores that keep the same no-commission, no-flattery rules.

## Licence

MIT. See `LICENSE`.
